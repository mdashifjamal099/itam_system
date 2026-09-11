/**
 * Auth.js v5 catch-all route handler.
 * Handles all /api/auth/* requests (signin, signout, session, csrf, callback, etc.)
 */
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
