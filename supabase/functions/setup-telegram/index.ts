import { makeHandlers } from "../_shared/core.js";
Deno.serve(makeHandlers(Deno.env.toObject()).setup);

