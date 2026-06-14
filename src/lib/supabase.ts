import { createClient } from '@supabase/supabase-js';
import { Profile, ProfileInput, Conversation, Message } from '../types';

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  console.warn("Supabase URL or Anon Key is missing. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.");
}

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co',
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder'
);

/**
 * Fetches a user's profile from the profiles table.
 * @param userId - The ID of the user.
 * @returns The user's profile, or null if not found.
 */
export async function getProfile(userId: string): Promise<Profile | null> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }
    return data as Profile;
  } catch (error) {
    console.error('Error fetching profile:', error);
    throw error;
  }
}

/**
 * Upserts a user's profile.
 * @param userId - The ID of the user.
 * @param profile - The profile data to insert/update.
 * @returns The upserted profile.
 */
export async function upsertProfile(userId: string, profile: ProfileInput): Promise<Profile> {
  let lastError = null;
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Attempt an update first (handles cases where a DB trigger already created the row)
      const { data: updateData, error: updateError } = await supabase
        .from('profiles')
        .update({ ...profile, updated_at: new Date().toISOString() })
        .eq('id', userId)
        .select()
        .maybeSingle();

      if (!updateError && updateData) {
        return updateData as Profile;
      }

      // If update yields no data, the row might not exist yet. Fall back to insert.
      const { data: insertData, error: insertError } = await supabase
        .from('profiles')
        .insert({ id: userId, ...profile, updated_at: new Date().toISOString() })
        .select()
        .single();

      if (insertError) throw insertError;
      return insertData as Profile;
      
    } catch (error: any) {
      lastError = error;
      // 42501 = RLS violation, 23505 = Unique constraint violation
      // If a database trigger is concurrently creating the profile, we'll get one of these on INSERT.
      if (error && (error.code === '42501' || error.code === '23505')) {
        // Wait 1.5s then retry the loop (which starts with UPDATE)
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
      }
      console.error('Error upserting profile:', error);
      throw error;
    }
  }
  
  if (lastError && (lastError as any).code === '42501') {
    throw new Error("RLS_INSERT_BLOCKED: You need to add an INSERT policy for the profiles table in Supabase! Go to Supabase -> Authentication -> Policies -> Profiles -> Add Policy: 'Enable insert for authenticated users only' with CHECK (auth.uid() = id).");
  }
  
  throw lastError || new Error("Failed to upsert profile after retries");
}

/**
 * Fetches all conversations for a given user.
 * @param userId - The ID of the user.
 * @returns A list of conversations.
 */
export async function getConversations(userId: string): Promise<Conversation[]> {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data as Conversation[];
  } catch (error) {
    console.error('Error fetching conversations:', error);
    throw error;
  }
}

/**
 * Gets an existing conversation between two users or creates a new one.
 * @param userId1 - The ID of the first user.
 * @param userId2 - The ID of the second user.
 * @returns The ID of the conversation.
 */
export async function getOrCreateConversation(userId1: string, userId2: string): Promise<string> {
  try {
    // Check if conversation already exists
    const { data: existing, error: fetchError } = await supabase
      .from('conversations')
      .select('id')
      .or(`and(user1_id.eq.${userId1},user2_id.eq.${userId2}),and(user1_id.eq.${userId2},user2_id.eq.${userId1})`)
      .limit(1);

    if (fetchError) throw fetchError;
    
    if (existing && existing.length > 0) {
      return existing[0].id; // Return existing conversation ID
    }

    // Create new conversation
    const { data: newConv, error: insertError } = await supabase
      .from('conversations')
      .insert({ user1_id: userId1, user2_id: userId2 })
      .select('id')
      .single();

    if (insertError) throw insertError;
    return newConv.id;
  } catch (error) {
    console.error('Error getting or creating conversation:', error);
    throw error;
  }
}

/**
 * Sends a message in a conversation.
 * @param conversationId - The ID of the conversation.
 * @param senderId - The ID of the sender.
 * @param encryptedContent - The encrypted message content.
 * @param nonce - The nonce used for encryption.
 * @returns The inserted message.
 */
export async function sendMessage(conversationId: string, senderId: string, encryptedContent: string, nonce: string): Promise<Message> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        encrypted_content: encryptedContent,
        nonce,
      })
      .select()
      .single();

    if (error) throw error;
    return data as Message;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
}

/**
 * Loads the latest messages for a conversation.
 * @param conversationId - The ID of the conversation.
 * @param limit - Max number of messages to fetch (default: 50).
 * @returns A list of messages.
 */
export async function loadMessages(conversationId: string, limit: number = 50): Promise<Message[]> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    // Return in chronological order (oldest to newest)
    return data.reverse() as Message[];
  } catch (error) {
    console.error('Error loading messages:', error);
    throw error;
  }
}

/**
 * Subscribes to real-time inserts on the messages table for a specific conversation.
 * @param conversationId - The ID of the conversation.
 * @param onInsert - Callback fired when a new message arrives.
 * @returns A function to unsubscribe.
 */
export function subscribeToMessages(conversationId: string, onInsert: (msg: Message) => void): () => void {
  const channel = supabase
    .channel(`messages:${conversationId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => {
        onInsert(payload.new as Message);
      }
    )
    .subscribe();

  // Return unsubscribe function
  return () => {
    supabase.removeChannel(channel);
  };
}
