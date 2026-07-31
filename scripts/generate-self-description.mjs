import { writeProjectSelfDescription } from "../bridge/self-description.mjs";

const result = writeProjectSelfDescription();
console.log("[self-description] wrote " + result.outputDir);
