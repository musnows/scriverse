export type StreamTypewriterProgress = {
  visibleCharacters: number;
  pendingCharacters: number;
};

export type StreamTypewriter = {
  append(value: unknown): void;
  replace(value: unknown): string;
  finish(): Promise<string>;
  reveal(): string;
};

export type StreamTypewriterSpeedController = {
  observe(characterCount: number): void;
  charactersPerSecond(): number;
};

export function createStreamTypewriterSpeedController(options?: {
  now?: () => number;
  initialCharactersPerSecond?: number;
}): StreamTypewriterSpeedController;

export function streamTypewriterBatchSize(pendingCharacters: number, finishing?: boolean, charactersPerSecond?: number): number;

export function createStreamTypewriter<FrameHandle = number>(options: {
  onRender: (text: string, progress: StreamTypewriterProgress) => void;
  scheduleFrame?: (callback: () => void) => FrameHandle;
  cancelFrame?: (handle: FrameHandle) => void;
  reducedMotion?: boolean;
  speedController?: StreamTypewriterSpeedController | null;
  visibilitySource?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> | null;
}): StreamTypewriter;
