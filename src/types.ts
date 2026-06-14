export interface User {
  id: string;
  email?: string;
}

export interface Profile {
  id: string;
  username: string;
  avatar_url?: string;
  public_key: string;
  created_at: string;
  updated_at: string;
}

export type ProfileInput = Omit<Profile, 'id' | 'created_at' | 'updated_at'>;

export interface Conversation {
  id: string;
  user1_id: string;
  user2_id: string;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  encrypted_content: string;
  nonce: string;
  created_at: string;
}
