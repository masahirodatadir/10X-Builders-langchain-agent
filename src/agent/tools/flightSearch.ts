import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getEnv } from "../../config/env.js";

const flightSearchInputSchema = z.object({
  origin: z.string().min(1).describe("Origen (IATA o ciudad), por ejemplo: BOG o Bogota"),
  destination: z.string().min(1).describe("Destino (IATA o ciudad), por ejemplo: MAD o Madrid"),
  departureDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado YYYY-MM-DD")
    .describe("Fecha de salida en formato YYYY-MM-DD"),
  returnDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado YYYY-MM-DD")
    .optional()
    .describe("Fecha de regreso en formato YYYY-MM-DD"),
  adults: z.number().int().positive().max(9).optional().default(1),
  budget: z.number().positive().optional().describe("Presupuesto máximo opcional")
});

type RawFlight = Record<string, unknown>;
type RawSegment = Record<string, unknown>;

interface NormalizedSegment {
  from: string | null;
  to: string | null;
  departure: string | null;
  arrival: string | null;
}

export interface NormalizedFlight {
  price: number | null;
  currency: string | null;
  airline: string | null;
  fareCategory: string | null;
  segments: NormalizedSegment[];
  stops: {
    count: number;
    airports: string[];
  };
}

interface FlightSearchResponse {
  summary: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    adults: number;
    budget?: number;
  };
  results: NormalizedFlight[];
  withinBudget?: NormalizedFlight[];
  overBudget?: NormalizedFlight[];
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractPriceNumber(price: unknown): number | null {
  if (typeof price === "number" && Number.isFinite(price)) {
    return price;
  }
  if (typeof price === "string") {
    const normalized = price.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractFareCategory(rawFlight: RawFlight): string | null {
  const fareType = rawFlight.fare_type;
  if (typeof fareType === "string" && fareType.trim().length > 0) {
    return fareType;
  }
  return null;
}

function normalizeSegment(rawSegment: RawSegment): NormalizedSegment {
  const departureAirport = (rawSegment.departure_airport ?? {}) as Record<string, unknown>;
  const arrivalAirport = (rawSegment.arrival_airport ?? {}) as Record<string, unknown>;
  return {
    from: toStringOrNull(departureAirport.id) ?? toStringOrNull(departureAirport.name),
    to: toStringOrNull(arrivalAirport.id) ?? toStringOrNull(arrivalAirport.name),
    departure: toStringOrNull(departureAirport.time),
    arrival: toStringOrNull(arrivalAirport.time)
  };
}

function buildStops(rawFlight: RawFlight, segments: NormalizedSegment[]): { count: number; airports: string[] } {
  const layovers = Array.isArray(rawFlight.layovers) ? (rawFlight.layovers as Array<Record<string, unknown>>) : [];
  const layoverAirports = layovers
    .map((item) => toStringOrNull(item.id) ?? toStringOrNull(item.name))
    .filter((item): item is string => item !== null);

  if (layoverAirports.length > 0) {
    return { count: layoverAirports.length, airports: layoverAirports };
  }

  const inferredStops = Math.max(segments.length - 1, 0);
  return { count: inferredStops, airports: [] };
}

export function normalizeSerpApiFlights(rawFlights: unknown): NormalizedFlight[] {
  if (!Array.isArray(rawFlights)) {
    return [];
  }

  const normalized: NormalizedFlight[] = [];

  for (const candidate of rawFlights) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const rawFlight = candidate as RawFlight;
    const rawSegments = Array.isArray(rawFlight.flights) ? (rawFlight.flights as RawSegment[]) : [];
    const segments = rawSegments.map(normalizeSegment);

    normalized.push({
      price: extractPriceNumber(rawFlight.price),
      currency: "USD",
      airline: toStringOrNull(rawSegments[0]?.airline),
      fareCategory: extractFareCategory(rawFlight),
      segments,
      stops: buildStops(rawFlight, segments)
    });
  }

  return normalized;
}

export function groupFlightsByBudget(flights: NormalizedFlight[], budget?: number): Pick<
  FlightSearchResponse,
  "results" | "withinBudget" | "overBudget"
> {
  if (!budget) {
    return { results: flights };
  }

  const withinBudget = flights.filter((flight) => flight.price !== null && flight.price <= budget);
  const overBudget = flights.filter((flight) => flight.price !== null && flight.price > budget);

  return {
    results: flights,
    withinBudget,
    overBudget
  };
}

async function fetchGoogleFlightsFromSerpApi(params: {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
}): Promise<unknown> {
  const env = getEnv();
  const searchParams = new URLSearchParams({
    engine: "google_flights",
    api_key: env.SERPAPI_API_KEY,
    departure_id: params.origin,
    arrival_id: params.destination,
    outbound_date: params.departureDate,
    adults: String(params.adults),
    hl: "es",
    gl: "us",
    currency: "USD"
  });

  if (params.returnDate) {
    searchParams.set("return_date", params.returnDate);
    searchParams.set("type", "1");
  } else {
    searchParams.set("type", "2");
  }

  const response = await fetch(`${env.SERPAPI_BASE_URL}?${searchParams.toString()}`);
  if (!response.ok) {
    throw new Error(`Error consultando vuelos (HTTP ${response.status})`);
  }

  return response.json();
}

export const flightSearchTool = tool(
  async ({ origin, destination, departureDate, returnDate, adults, budget }) => {
    try {
      const apiResponse = (await fetchGoogleFlightsFromSerpApi({
        origin,
        destination,
        departureDate,
        returnDate,
        adults
      })) as Record<string, unknown>;

      const bestFlights = normalizeSerpApiFlights(apiResponse.best_flights);
      const otherFlights = normalizeSerpApiFlights(apiResponse.other_flights);
      const merged = [...bestFlights, ...otherFlights];
      const grouped = groupFlightsByBudget(merged, budget);

      const output: FlightSearchResponse = {
        summary: {
          origin,
          destination,
          departureDate,
          returnDate,
          adults,
          budget
        },
        ...grouped
      };

      if (merged.length === 0) {
        return JSON.stringify(
          {
            ...output,
            note: "No se encontraron vuelos con los parámetros solicitados."
          },
          null,
          2
        );
      }

      return JSON.stringify(output, null, 2);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error desconocido al consultar vuelos.";
      return JSON.stringify(
        {
          error: `No pude consultar vuelos: ${message}`
        },
        null,
        2
      );
    }
  },
  {
    name: "flight_search",
    description:
      "Busca vuelos en Google Flights vía SerpAPI y devuelve precio, horarios, escalas, categoría de tarifa cuando exista y agrupación por presupuesto.",
    schema: flightSearchInputSchema
  }
);
