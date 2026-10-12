import type { Output } from './driver';
import type { ConnectOpts, Session } from './connect';

export async function interactive(_s: Session, _o: ConnectOpts, _write: (o: Output) => void, writeLine: (line: string) => void): Promise<number> {
  writeLine('Interactive mode arrives in Task 3; use --script for now.');
  return 2;
}
