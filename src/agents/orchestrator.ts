import { StateGraph, END, START } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

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
});

// Define the nodes
const planNode = async (state: typeof OrchestratorState.State) => {
  console.log("Planning...");
  // In a real scenario, we'd use an LLM to generate a plan
  return {
    plan: ["Research trends", "Generate content", "Post to social media"],
    nextStep: "execute",
  };
};

const executeNode = async (state: typeof OrchestratorState.State) => {
  console.log("Executing...");
  const currentTask = state.plan[0];
  console.log(`Executing task: ${currentTask}`);
  
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
