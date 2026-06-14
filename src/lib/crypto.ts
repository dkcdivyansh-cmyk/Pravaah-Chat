import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2.js';
import { openDB, IDBPDatabase, DBSchema } from 'idb';

interface PravaahDB extends DBSchema {
  keys: {
    key: string;
    value: {
      id: string;
      key: Uint8Array;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<PravaahDB>> | null = null;

async function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<PravaahDB>('pravaah-crypto', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

// Helpers for Base64 encoding/decoding
export function encodeBase64(arr: Uint8Array): string {
  let binary = '';
  const len = arr.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return window.btoa(binary);
}

export function decodeBase64(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 1. generateDeviceKeyPair()
 * Generates a new Curve25519 keypair for device identification and key exchange.
 */
export async function generateDeviceKeyPair(): Promise<{
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}> {
  try {
    const keyPair = nacl.box.keyPair();
    if (!keyPair.publicKey || !keyPair.secretKey) {
      throw new Error('Underlying generator returned empty keys.');
    }
    return keyPair;
  } catch (error) {
    throw new Error(`Failed to generate device keypair: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * 2. storeDevicePrivateKey(secretKey)
 * Stores the device private key securely in IndexedDB.
 */
export async function storeDevicePrivateKey(secretKey: Uint8Array): Promise<void> {
  try {
    const db = await getDB();
    await db.put('keys', { id: 'device_private_key', key: secretKey });
  } catch (error) {
    throw new Error(`IndexedDB storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * 3. loadDevicePrivateKey()
 * Loads the device private key securely from IndexedDB.
 */
export async function loadDevicePrivateKey(): Promise<Uint8Array> {
  try {
    const db = await getDB();
    const record = await db.get('keys', 'device_private_key');
    if (!record || !record.key) {
      throw new Error('No device private key found in storage.');
    }
    return record.key;
  } catch (error) {
    throw new Error(`Failed to load private key from IndexedDB: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * 4. encryptMessage(plaintext, key)
 * Encrypts a message using XSalsa20-Poly1305 AEAD.
 */
export async function encryptMessage(
  plaintext: string,
  key: Uint8Array
): Promise<{ ciphertext: string; nonce: string }> {
  try {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const messageUint8 = new TextEncoder().encode(plaintext);
    const encrypted = nacl.secretbox(messageUint8, nonce, key);
    
    return {
      ciphertext: encodeBase64(encrypted),
      nonce: encodeBase64(nonce),
    };
  } catch (error) {
    throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * 5. decryptMessage(ciphertext, nonce, key)
 * Decrypts a message using XSalsa20-Poly1305 AEAD.
 */
export async function decryptMessage(
  ciphertextBase64: string,
  nonceBase64: string,
  key: Uint8Array
): Promise<string> {
  try {
    const ciphertext = decodeBase64(ciphertextBase64);
    const nonce = decodeBase64(nonceBase64);
    
    const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
    if (!decrypted) {
      throw new Error('Message corrupted or tampered with (Auth Tag verification failed)');
    }
    
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * 6. deriveMessageKey(sharedSecret, counter)
 * Derives a per-message key using BLAKE2b KDF to prevent key reuse.
 */
export async function deriveMessageKey(
  sharedSecret: Uint8Array,
  counter: number
): Promise<Uint8Array> {
  try {
    const counterBytes = new Uint8Array(8);
    new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter), false);
    
    const combined = new Uint8Array(sharedSecret.length + counterBytes.length);
    combined.set(sharedSecret);
    combined.set(counterBytes, sharedSecret.length);
    
    return blake2b(combined, { dkLen: 32 });
  } catch (error) {
    throw new Error(`Key derivation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * 7. deriveSharedSecret(theirPublicKey, mySecretKey)
 * Derives a shared secret using Curve25519 ECDH.
 */
export async function deriveSharedSecret(
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): Promise<Uint8Array> {
  try {
    const sharedSecret = nacl.box.before(theirPublicKey, mySecretKey);
    return sharedSecret;
  } catch (error) {
    throw new Error(`ECDH failed during shared secret derivation: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
