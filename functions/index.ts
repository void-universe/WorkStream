import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { serveSite } from "./adapter.mjs";
import { makeHandler } from "./handler.mjs";

const env = (name: string) => Deno.env.get(name);

// 单一 app Edge Function：所有业务动作都走 ?action=<名称>，鉴权在应用层完成。
Deno.serve(serveSite(makeHandler({ env }), { createClient, env }));
