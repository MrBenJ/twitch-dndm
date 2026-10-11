export interface GameEvent {
  type: string;
  at: number;
  text: string;
  data: Record<string, unknown>;
}
