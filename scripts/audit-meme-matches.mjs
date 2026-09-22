import { retiredMemeResult } from "../bridge/knowledge/memes/archive.mjs";

// Compatibility command: never read chats or restart the retired matcher.
console.log(JSON.stringify(retiredMemeResult(), null, 2));
