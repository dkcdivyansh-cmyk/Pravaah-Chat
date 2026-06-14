import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, Profile } from '../types';

interface AuthState {
  user: User | null;
  profile: Profile | null;
  deviceId: string | null;
  setUser: (user: User | null) => void;
  setProfile: (profile: Profile | null) => void;
  setDeviceId: (deviceId: string | null) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      profile: null,
      deviceId: null,
      setUser: (user) => set({ user }),
      setProfile: (profile) => set({ profile }),
      setDeviceId: (deviceId) => set({ deviceId }),
      reset: () => set({ user: null, profile: null, deviceId: null }),
    }),
    {
      name: 'pravaah-auth-storage',
    }
  )
);
