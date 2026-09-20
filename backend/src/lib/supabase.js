import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();
const normalizedSupabaseUrl = supabaseUrl?.replace(/\/rest\/v1\/?$/, "");

export const supabase = normalizedSupabaseUrl && supabaseSecretKey
    ? createClient(normalizedSupabaseUrl, supabaseSecretKey, {
        realtime: {
            transport: WebSocket
        }
    })
    : null;

if (!supabaseUrl) {
    console.warn("SUPABASE_URL is missing. Database features will be disabled.");
}

if (!supabaseSecretKey) {
    console.warn("SUPABASE_SECRET_KEY is missing. Database features will be disabled.");
}