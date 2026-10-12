export interface GameEvent {
  type: string;
  at: number;
  text: string;
  data: Record<string, unknown>;
  /** Character IDs who may see this event. Absent means public (spec 2a §7.2). */
  audience?: string[];
}
