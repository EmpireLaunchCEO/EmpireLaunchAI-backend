import { StateGraph, END, START } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { etsyService } from "../services/etsyService.js";
import { metaService } from "../services/metaService.js";

// Define the state of the agent
const OrchestratorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  nextStep: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "plan",
  }),
  plan: Annotation<string[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  userId: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  context: Annotation<any>({
    reducer: (x, y) => ({ ...x, ...y }),
    default: () => ({}),
  }),
});

// Define the nodes
const planNode = async (state: typeof OrchestratorState.State) => {
  console.log("Planning...");
  // In a real scenario, we'd use an LLM to generate a plan based on user input
  // and check which integrations are active for the user
  return {
    plan: ["Research trends", "Generate content", "List on Etsy", "Post to Instagram"],
    nextStep: "execute",
  };
};

const executeNode = async (state: typeof OrchestratorState.State) => {
  console.log("Executing...");
  if (state.plan.length === 0) {
    return { nextStep: "end" };
  }

  const currentTask = state.plan[0];
  console.log(`Executing task: ${currentTask}`);
  
  // Logic to delegate to specialized services
  if (currentTask === "List on Etsy") {
    console.log("Delegating to Etsy Service...");
    // Here we would fetch credentials from DB and call etsyService.createListing
  } else if (currentTask === "Post to Instagram") {
    console.log("Delegating to Meta Service...");
    // Here we would fetch credentials from DB and call metaService.postToInstagram
  }
  
  // Update plan to remove the completed task
  const remainingPlan = state.plan.slice(1);
  
  return {
    plan: remainingPlan,
    nextStep: remainingPlan.length > 0 ? "execute" : "end",
  };
};

// Create the graph
const workflow = new StateGraph(OrchestratorState)
  .addNode("plan", planNode)
  .addNode("execute", executeNode)
  .addEdge(START, "plan")
  .addEdge("plan", "execute")
  .addConditionalEdges("execute", (state) => {
    if (state.nextStep === "end") {
      return END;
    }
    return "execute";
  });

export const orchestrator = workflow.compile();
