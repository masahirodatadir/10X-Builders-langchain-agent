import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flightSearchTool,
  groupFlightsByBudget,
  normalizeSerpApiFlights,
  type NormalizedFlight
} from "../src/agent/tools/flightSearch.js";

const originalEnv = { ...process.env };

function setSerpApiEnv(): void {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.SERPAPI_API_KEY = "serp-test-key";
  process.env.SERPAPI_BASE_URL = "https://serpapi.com/search.json";
}

describe("flightSearch tool helpers", () => {
  it("normaliza todos los vuelos y conserva fareCategory si viene de la API", () => {
    const rawFlights = [
      {
        price: "$320",
        flights: [
          {
            airline: "Air A",
            departure_airport: { id: "BOG", time: "2026-06-01 08:00" },
            arrival_airport: { id: "MIA", time: "2026-06-01 12:00" }
          }
        ],
        fare_type: "Basic Economy"
      },
      {
        price: "$450",
        flights: [
          {
            airline: "Air B",
            departure_airport: { id: "BOG", time: "2026-06-01 09:00" },
            arrival_airport: { id: "MIA", time: "2026-06-01 13:00" }
          }
        ],
        fare_type: "Main Cabin"
      }
    ];

    const normalized = normalizeSerpApiFlights(rawFlights);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({
      price: 320,
      fareCategory: "Basic Economy",
      stops: { count: 0, airports: [] }
    });
    expect(normalized[1]).toMatchObject({
      price: 450,
      fareCategory: "Main Cabin"
    });
  });

  it("agrupa vuelos por presupuesto en <= y >", () => {
    const flights: NormalizedFlight[] = [
      {
        price: 300,
        currency: "USD",
        airline: "A",
        fareCategory: "Economy",
        segments: [],
        stops: { count: 0, airports: [] }
      },
      {
        price: 520,
        currency: "USD",
        airline: "B",
        fareCategory: "Economy",
        segments: [],
        stops: { count: 1, airports: ["MEX"] }
      }
    ];

    const grouped = groupFlightsByBudget(flights, 400);
    expect(grouped.withinBudget).toHaveLength(1);
    expect(grouped.overBudget).toHaveLength(1);
    expect(grouped.withinBudget?.[0].price).toBe(300);
    expect(grouped.overBudget?.[0].price).toBe(520);
  });
});

describe("flightSearchTool", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("soporta one-way cuando no hay returnDate", async () => {
    setSerpApiEnv();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        best_flights: [
          {
            price: "$280",
            fare_type: "Basic Economy",
            flights: [
              {
                airline: "Air C",
                departure_airport: { id: "BOG", time: "2026-07-10 06:00" },
                arrival_airport: { id: "LIM", time: "2026-07-10 09:00" }
              }
            ]
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await flightSearchTool.invoke({
      origin: "BOG",
      destination: "LIM",
      departureDate: "2026-07-10",
      adults: 1
    });
    const parsed = JSON.parse(String(result)) as { summary: { returnDate?: string }; results: unknown[] };

    expect(parsed.summary.returnDate).toBeUndefined();
    expect(parsed.results).toHaveLength(1);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("type=2");
  });

  it("soporta round-trip cuando hay returnDate y clasifica por presupuesto", async () => {
    setSerpApiEnv();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        best_flights: [
          {
            price: "$350",
            fare_type: "Basic Economy",
            flights: [
              {
                airline: "Air D",
                departure_airport: { id: "BOG", time: "2026-08-01 07:00" },
                arrival_airport: { id: "MAD", time: "2026-08-01 22:00" }
              }
            ]
          }
        ],
        other_flights: [
          {
            price: "$700",
            fare_type: "Basic Economy",
            flights: [
              {
                airline: "Air E",
                departure_airport: { id: "BOG", time: "2026-08-01 09:00" },
                arrival_airport: { id: "MAD", time: "2026-08-02 00:30" }
              }
            ]
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await flightSearchTool.invoke({
      origin: "BOG",
      destination: "MAD",
      departureDate: "2026-08-01",
      returnDate: "2026-08-20",
      adults: 1,
      budget: 500
    });
    const parsed = JSON.parse(String(result)) as {
      withinBudget: Array<{ price: number }>;
      overBudget: Array<{ price: number }>;
    };

    expect(parsed.withinBudget).toHaveLength(1);
    expect(parsed.overBudget).toHaveLength(1);
    expect(parsed.withinBudget[0].price).toBe(350);
    expect(parsed.overBudget[0].price).toBe(700);

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("type=1");
    expect(calledUrl).toContain("return_date=2026-08-20");
  });

  it("devuelve error legible cuando falla HTTP", async () => {
    setSerpApiEnv();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await flightSearchTool.invoke({
      origin: "BOG",
      destination: "MIA",
      departureDate: "2026-07-10",
      adults: 1
    });
    const parsed = JSON.parse(String(result)) as { error: string };
    expect(parsed.error).toContain("No pude consultar vuelos");
  });

  it("devuelve error legible cuando falta SERPAPI_API_KEY", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.SERPAPI_API_KEY;
    process.env.SERPAPI_BASE_URL = "https://serpapi.com/search.json";
    vi.stubGlobal("fetch", vi.fn());

    const result = await flightSearchTool.invoke({
      origin: "BOG",
      destination: "MIA",
      departureDate: "2026-07-10",
      adults: 1
    });
    const parsed = JSON.parse(String(result)) as { error: string };
    expect(parsed.error).toContain("SERPAPI_API_KEY");
  });
});
