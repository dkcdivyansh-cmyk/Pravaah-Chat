import { create } from 'zustand';

interface UiState {
  sidebarOpen: boolean;
  activeConversationId: string | null;
  settingsOpen: boolean;
  toggleSidebar: () => void;
  setActiveConversation: (id: string | null) => void;
  toggleSettings: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: false,
  activeConversationId: null,
  settingsOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  toggleSettings: () => set((state) => ({ settingsOpen: !state.settingsOpen })),
}));
