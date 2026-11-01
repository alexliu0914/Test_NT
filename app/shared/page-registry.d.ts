export const pageRegistry: {
  set(list: { id: string; title: string; icon: string | null }[]): void;
  get(id: string): { title: string; icon: string | null } | null;
  loaded(): boolean;
  list(): { id: string; title: string; icon: string | null }[];
  subscribe(fn: () => void): () => void;
  setNavigate(fn: (path: string) => void): void;
  navigate(path: string): void;
};
