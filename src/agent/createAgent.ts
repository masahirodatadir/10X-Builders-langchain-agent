import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
import { createModel } from "./model.js";
import { calculatorTool } from "./tools/calculator.js";
import { currentTimeTool } from "./tools/currentTime.js";
import { flightSearchTool } from "./tools/flightSearch.js";
import { agentPrompt } from "./prompt.js";

export const agentTools = [calculatorTool, currentTimeTool, flightSearchTool];

export async function buildAgentExecutor(verbose = true): Promise<AgentExecutor> {
  const model = createModel();

  const agent = await createToolCallingAgent({
    llm: model,
    tools: agentTools,
    prompt: agentPrompt
  });

  return new AgentExecutor({
    agent,
    tools: agentTools,
    verbose
  });
}
