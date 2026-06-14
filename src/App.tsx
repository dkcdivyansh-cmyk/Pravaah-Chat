/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { useUiStore } from './store/uiStore';
import { useAuthStore } from './store/authStore';
import { supabase, getProfile, upsertProfile, getConversations, getOrCreateConversation, sendMessage, loadMessages, subscribeToMessages } from './lib/supabase';
import { generateDeviceKeyPair, storeDevicePrivateKey, loadDevicePrivateKey, encryptMessage, decryptMessage, deriveMessageKey, deriveSharedSecret, encodeBase64, decodeBase64 } from './lib/crypto';
import { Profile, Message } from './types';

export default function App() {
  const { activeConversationId, setActiveConversation } = useUiStore();
  const { user, profile, setUser, setProfile } = useAuthStore();
  
  const [messages, setMessages] = useState<(Message & { decodedText: string, sent: boolean })[]>([]);
  const [contacts, setContacts] = useState<Profile[]>([]);
  const [activeContact, setActiveContact] = useState<Profile | null>(null);
  const [inputVal, setInputVal] = useState("");
  
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authUsername, setAuthUsername] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  
  const [isProcessingAuth, setIsProcessingAuth] = useState(false);
  const [deviceKey, setDeviceKey] = useState<Uint8Array | null>(null);
  const [rlsError, setRlsError] = useState<string | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle Session & Crypto initialization reliably 
  const handlingSessionRef = useRef(false);

  useEffect(() => {
    const handleSessionGained = async (authUser: any) => {
      if (handlingSessionRef.current) return;
      handlingSessionRef.current = true;
      try {
        let privKey = await loadDevicePrivateKey().catch(() => null);
        let pubKeyBase64 = "";

        const existingProfile = await getProfile(authUser.id);

        if (!privKey) {
          const keyPair = await generateDeviceKeyPair();
          await storeDevicePrivateKey(keyPair.secretKey);
          privKey = keyPair.secretKey;
          pubKeyBase64 = encodeBase64(keyPair.publicKey);
        } else if (existingProfile) {
          pubKeyBase64 = existingProfile.public_key;
        }

        setDeviceKey(privKey!);

        if (!existingProfile || pubKeyBase64 !== existingProfile.public_key) {
          const username = authUser.user_metadata?.username || authUser.email?.split('@')[0] || "Unknown";
          const userProfile = await upsertProfile(authUser.id, {
            username: username,
            public_key: pubKeyBase64,
            avatar_url: existingProfile?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`
          });
          setProfile(userProfile);
        } else {
          setProfile(existingProfile);
        }

        setUser({ id: authUser.id, email: authUser.email });

        // Load available contacts
        const { data } = await supabase.from('profiles').select('*').neq('id', authUser.id);
        if (data) setContacts(data as Profile[]);
      } catch (err: any) {
        if (err?.message?.includes("Failed to fetch") || err?.message?.includes("network")) {
            alert("Network Error: 'Failed to fetch'. This usually means your VITE_SUPABASE_URL is missing or incorrect in the environment variables, or an ad-blocker is blocking the request. Check your .env file and restart the server.");
        } else if (err?.message?.includes("RLS_INSERT_BLOCKED") || err?.code === '42501' || err?.message?.includes("row-level security")) {
            setRlsError("Row-Level Security (RLS) is blocking access. You need to configure policies in Supabase.");
        }
        console.error("Session setup error:", JSON.stringify(err, null, 2), err);
      } finally {
        handlingSessionRef.current = false;
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) handleSessionGained(session.user);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        handleSessionGained(session.user);
      } else {
        setDeviceKey(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Subscribe and load messages when a contact is selected
  useEffect(() => {
    if (!user || !deviceKey || !activeContact || !activeConversationId) return;

    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    const fetchAndDecrypt = async () => {
      try {
        const encryptedMsgs = await loadMessages(activeConversationId);
        
        // Derive shared secret
        const theirPublicKey = decodeBase64(activeContact.public_key);
        const sharedSecret = await deriveSharedSecret(theirPublicKey, deviceKey);
        const msgKey = await deriveMessageKey(sharedSecret, 0); // Simplified Phase 1 No Ratchet

        const decrypted = [];
        for (const msg of encryptedMsgs) {
          try {
            const text = await decryptMessage(msg.encrypted_content, msg.nonce, msgKey);
            decrypted.push({ ...msg, decodedText: text, sent: msg.sender_id === user.id });
          } catch (err) {
            decrypted.push({ ...msg, decodedText: "*(Decryption Failed)*", sent: msg.sender_id === user.id });
          }
        }
        
        if (isMounted) setMessages(decrypted);

        // Subscribe to new incoming messages
        unsubscribe = subscribeToMessages(activeConversationId, async (newMsg) => {
           try {
              const text = await decryptMessage(newMsg.encrypted_content, newMsg.nonce, msgKey);
              const processedMsg = { ...newMsg, decodedText: text, sent: newMsg.sender_id === user.id };
              setMessages(prev => [...prev, processedMsg]);
           } catch {
              setMessages(prev => [...prev, { ...newMsg, decodedText: "*(Decryption Failed)*", sent: newMsg.sender_id === user.id }]);
           }
        });

      } catch (err) {
        console.error("Failed to load conversation", err);
      }
    };

    fetchAndDecrypt();

    return () => {
      isMounted = false;
      if (unsubscribe) unsubscribe();
    };
  }, [activeConversationId, activeContact, user, deviceKey]);


  const handleAuth = async () => {
    if (!email.trim() || !password.trim()) return;
    setIsProcessingAuth(true);
    setAuthMessage("");
    try {
      if (isSignUp) {
        if (!authUsername.trim()) throw new Error("Username is required for signup.");
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: authUsername } }
        });
        if (error) throw error;
        if (!data.session) {
          setAuthMessage("Success! Please check your email inbox to confirm your account.");
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err: any) {
      const msg = err?.message || "Unknown error";
      if (msg.includes("rate limit") || msg.includes("over the email rate limit")) {
        alert("🚨 SUPABASE RATE LIMIT HIT 🚨\nPlease increase the 'Email rate limit' in Supabase Dashboard -> Authentication -> Providers -> Email.");
      } else {
        alert(`Auth Error: ${msg}`);
      }
    } finally {
      setIsProcessingAuth(false);
    }
  };

  const selectContact = async (contact: Profile) => {
    if (!user) return;
    setActiveContact(contact);
    const convId = await getOrCreateConversation(user.id, contact.id);
    setActiveConversation(convId);
  };

  const handleSend = async () => {
    if (!inputVal.trim() || !activeConversationId || !activeContact || !user || !deviceKey) return;
    
    const textToSend = inputVal;
    setInputVal("");
    
    try {
      const theirPublicKey = decodeBase64(activeContact.public_key);
      const sharedSecret = await deriveSharedSecret(theirPublicKey, deviceKey);
      const msgKey = await deriveMessageKey(sharedSecret, 0); // Simplified Phase 1 No Ratchet
      
      const { ciphertext, nonce } = await encryptMessage(textToSend, msgKey);
      await sendMessage(activeConversationId, user.id, ciphertext, nonce);
      
      // We don't append to local state immediately — the realtime subscription will pick it up
      // but for snappier UI you can optimistically append here.
    } catch (err) {
      console.error("Failed to send message", err);
      alert("Failed to send encrypted message.");
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setDeviceKey(null);
    setActiveConversation(null);
    setActiveContact(null);
    setEmail("");
    setPassword("");
    setAuthMessage("");
  };

  if (rlsError) {
    return (
      <div className="min-h-screen bg-neutral-900 flex items-center justify-center p-4 font-sans text-white">
        <div className="max-w-2xl w-full bg-black/60 border border-red-500/30 p-8 rounded-2xl shadow-2xl backdrop-blur-xl">
          <h2 className="text-2xl font-bold text-red-400 mb-4 flex items-center gap-3">
            <span className="text-3xl">🛡️</span> Security Policy Error
          </h2>
          <p className="text-neutral-300 mb-6 leading-relaxed">
            {rlsError} Your application cannot read or write to the database because Supabase's Row Level Security is blocking the requests.
          </p>
          
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-6 mb-6">
            <h3 className="font-semibold text-white mb-3 text-lg">How to fix this quickly:</h3>
            <p className="text-sm text-neutral-400 mb-4">Go to your Supabase Dashboard, click on <strong>SQL Editor</strong> in the left sidebar, and run this entire SQL snippet to set up the correct policies:</p>
            
            <pre className="bg-black border border-neutral-700/50 text-emerald-400 p-4 rounded-lg text-sm overflow-x-auto whitespace-pre font-mono">
{`-- 1. Drop existing specific policies to avoid conflicts
drop policy if exists "Enable insert for authenticated users only" on public.profiles;
drop policy if exists "policy_name" on public.profiles;

-- 2. Allow users to manage their OWN profile (Insert/Update)
create policy "Allow users to manage own profile"
on public.profiles
for ALL
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- 3. Allow EVERYONE to read ALL profiles (so you can see who to message)
create policy "Allow public read profiles"
on public.profiles
for SELECT
to public
using (true);`}
            </pre>
          </div>
          
          <button 
            onClick={() => window.location.reload()}
            className="w-full bg-red-600 hover:bg-red-500 text-white font-medium py-3 px-6 rounded-xl transition-all"
          >
            I have run the SQL snippet. Reload App.
          </button>
        </div>
      </div>
    );
  }

  if (!user && !profile) {
    return (
      <>
        <div className="mesh-bg"></div>
        <div className="flex h-screen w-full items-center justify-center relative z-10 p-4">
          <div className="w-[400px] flex flex-col items-center glass rounded-2xl p-8 shadow-2xl">
            <div className="text-xl font-bold tracking-widest uppercase text-blue-500 mb-2">PRAVAAH</div>
            <div className="text-sm opacity-60 mb-8 text-center text-white">Secure E2E Encrypted Messaging</div>
            
            {authMessage && (
              <div className="w-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-100 text-sm p-3 rounded-lg mb-6 text-center">
                {authMessage}
              </div>
            )}

            {isSignUp && (
              <input 
                type="text" 
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500/50 transition-colors mb-4" 
                placeholder="Choose a Username"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
              />
            )}

            <input 
              type="email" 
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500/50 transition-colors mb-4" 
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <input 
              type="password" 
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500/50 transition-colors mb-6" 
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAuth()}
            />
            
            <button 
              onClick={handleAuth}
              disabled={isProcessingAuth || !email || !password || (isSignUp && !authUsername)}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold py-3 px-6 rounded-xl transition-all shadow-lg hover:shadow-blue-500/25 active:scale-95 mb-4"
            >
              {isProcessingAuth ? "Processing..." : (isSignUp ? "Create Account" : "Sign In")}
            </button>
            
            <button 
              onClick={() => { setIsSignUp(!isSignUp); setAuthMessage(""); }}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {isSignUp ? "Already have an account? Sign in" : "Need an account? Sign up"}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mesh-bg"></div>
      
      <div className="flex h-screen w-full relative z-10 p-4 gap-4 overflow-hidden">
        
        {/* Sidebar */}
        <aside className="w-[280px] flex flex-col glass rounded-xl shrink-0">
          <div className="text-xs font-bold tracking-widest uppercase text-blue-500 pt-5 px-6 pb-2">
            PRAVAAH
          </div>
          
          <div className="p-4 mb-2 flex items-center gap-3 border-b border-white/5">
             {profile?.avatar_url ? (
                <img src={profile.avatar_url} alt="avatar" className="w-10 h-10 rounded-full shrink-0 bg-black/20" />
             ) : (
                <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 shrink-0"></div>
             )}
            <div className="overflow-hidden">
              <div className="font-semibold text-sm text-white truncate">{profile?.username || "Loading..."}</div>
              <div className="text-[10px] opacity-60 text-emerald-400 truncate mt-0.5 font-mono" title={profile?.public_key}>
                🔑 {profile?.public_key.substring(0, 10)}...
              </div>
            </div>
          </div>
          
          <div className="px-4 py-2 text-[11px] opacity-40 uppercase tracking-widest mt-2 text-white">
            Secret Contacts
          </div>
          
          <div className="flex-1 overflow-y-auto flex flex-col gap-1 pb-4">
            {contacts.length === 0 ? (
              <div className="px-4 py-3 text-xs text-white/40 italic">
                 No other users registered yet. Open the app in a new incognito window and sign in with a different username!
              </div>
            ) : contacts.map((contact, idx) => (
              <div 
                key={contact.id}
                onClick={() => selectContact(contact)}
                className={`px-4 py-3 mx-2 rounded-lg cursor-pointer flex items-center gap-3 text-sm transition-all text-white ${
                  activeContact?.id === contact.id
                    ? 'bg-blue-500/20 border border-blue-500/30' 
                    : 'hover:bg-white/5 border border-transparent'
                }`}
              >
                <div className="w-2 h-2 rounded-full shrink-0 bg-emerald-500"></div>
                <div className="truncate flex-1">
                   <div className="font-medium">{contact.username}</div>
                </div>
              </div>
            ))}
          </div>
          
          <div className="p-4 mt-auto border-t border-white/5 text-white">
            <div onClick={handleLogout} className="px-4 py-3 rounded-lg cursor-pointer flex items-center gap-3 text-sm transition-all hover:bg-red-500/20 text-red-400 border border-transparent">
              <span>Sign out</span>
            </div>
          </div>
        </aside>
        
        {/* Main View */}
        <main className="flex-1 flex flex-col glass rounded-xl min-w-0 relative">
          {!activeContact ? (
             <div className="flex-1 flex flex-col items-center justify-center text-white/50">
               <div className="text-4xl mb-4">🔐</div>
               <div className="font-medium tracking-wide">Select a contact to start encrypted session</div>
             </div>
          ) : (
            <>
              <div className="p-5 flex justify-between items-center border-b border-white/5 shrink-0 text-white">
                <div>
                  <div className="font-semibold text-lg">{activeContact?.username}</div>
                  <div className="text-xs text-emerald-500 flex items-center gap-1 mt-0.5">
                    <span className="text-[10px]">●</span> Secured via Curve25519 ECDH
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="px-3 py-1.5 text-xs bg-emerald-500/10 border border-emerald-500/20 rounded-lg glass text-emerald-400">
                    E2E Secure
                  </div>
                </div>
              </div>
              
              <div className="flex-1 p-6 flex flex-col gap-4 overflow-y-auto">
                {messages.length === 0 && (
                   <div className="text-center text-xs text-white/40 italic py-10">
                     This is the beginning of your encrypted history with {activeContact.username}. <br/>
                     Messages are stored as unreadable ciphertexts on the server.
                   </div>
                )}
                {messages.map((msg) => (
                  <div key={msg.id} className={`max-w-[70%] px-4 py-3 rounded-xl text-sm leading-relaxed ${
                    msg.sent ? 'bg-blue-500/40 self-end text-white' : 'bg-white/5 self-start text-white'
                  }`}>
                    <span className={`text-[9px] uppercase tracking-widest mb-1.5 flex items-center justify-between gap-4 ${msg.sent ? 'text-blue-200' : 'text-slate-400'}`}>
                      <span>Encrypted • AES-GCM</span>
                    </span>
                    <div className="whitespace-pre-wrap word-break break-words">
                      {msg.decodedText}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              
              <div className="p-5 border-t border-white/5 flex gap-3 shrink-0">
                <input 
                  type="text" 
                  className="flex-1 bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500/50 transition-colors" 
                  placeholder="Type an encrypted message..."
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                />
                <button 
                  onClick={handleSend}
                  disabled={!inputVal.trim()}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 px-8 rounded-lg transition-colors text-sm"
                >
                  Send
                </button>
              </div>
            </>
          )}
        </main>
        
      </div>
    </>
  );
}
