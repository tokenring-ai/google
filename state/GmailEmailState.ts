import {AgentStateSlice} from "@tokenring-ai/agent/types";
import {z} from "zod";

const serializationSchema = z.object({
  currentMessage: z.any().nullable(),
  currentDraft: z.any().nullable(),
}).prefault({currentMessage: null, currentDraft: null});

export class GmailEmailState extends AgentStateSlice<typeof serializationSchema> {
  currentMessage: any | null;
  currentDraft: any | null;

  constructor(_initialConfig: {currentMessage?: any | null; currentDraft?: any | null} = {}) {
    super("GmailEmailState", serializationSchema);
    this.currentMessage = null;
    this.currentDraft = null;
  }

  reset(): void {
    this.currentMessage = null;
    this.currentDraft = null;
  }

  serialize(): z.output<typeof serializationSchema> {
    return {
      currentMessage: this.currentMessage,
      currentDraft: this.currentDraft,
    };
  }

  deserialize(data: z.output<typeof serializationSchema>): void {
    this.currentMessage = data.currentMessage ?? null;
    this.currentDraft = data.currentDraft ?? null;
  }

  show(): string[] {
    return [
      `Current Gmail Message: ${this.currentMessage?.subject ?? "None"}`,
      `Current Gmail Draft: ${this.currentDraft?.subject ?? "None"}`,
    ];
  }
}
