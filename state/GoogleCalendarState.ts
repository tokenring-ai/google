import {AgentStateSlice} from "@tokenring-ai/agent/types";
import {z} from "zod";

const serializationSchema = z.object({
  currentEvent: z.any().nullable(),
}).prefault({currentEvent: null});

export class GoogleCalendarState extends AgentStateSlice<typeof serializationSchema> {
  currentEvent: any | null;

  constructor(_initialConfig: {currentEvent?: any | null} = {}) {
    super("GoogleCalendarState", serializationSchema);
    this.currentEvent = null;
  }

  reset(): void {
    this.currentEvent = null;
  }

  serialize(): z.output<typeof serializationSchema> {
    return {currentEvent: this.currentEvent};
  }

  deserialize(data: z.output<typeof serializationSchema>): void {
    this.currentEvent = data.currentEvent ?? null;
  }

  show(): string[] {
    return [
      `Current Calendar Event: ${this.currentEvent?.title ?? "None"}`,
    ];
  }
}
