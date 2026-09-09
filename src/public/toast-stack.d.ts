export function createToastStack(region: HTMLElement, options?: { onEmpty?: () => void }): {
  element: HTMLDivElement;
  add(toast: HTMLElement): void;
  dismiss(toast: HTMLElement): boolean;
  clear(): void;
};
