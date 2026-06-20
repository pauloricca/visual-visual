import { createContext, useContext, type ReactNode } from 'react';

const EdgeOverlayContext = createContext<HTMLElement | null>(null);

interface EdgeOverlayProviderProps {
  target: HTMLElement | null;
  children: ReactNode;
}

export function EdgeOverlayProvider({ target, children }: EdgeOverlayProviderProps) {
  return (
    <EdgeOverlayContext.Provider value={target}>
      {children}
    </EdgeOverlayContext.Provider>
  );
}

export function useEdgeOverlayTarget(): HTMLElement | null {
  return useContext(EdgeOverlayContext);
}
