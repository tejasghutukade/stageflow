import { createRequire } from "node:module";
import { assertOpenUiTelemetryDisabled } from "./telemetryGuard.js";

assertOpenUiTelemetryDisabled();

const require = createRequire(import.meta.url);
const lang = require("@openuidev/lang-core") as typeof import("@openuidev/lang-core");

export const action = lang.action;
export const createLibrary = lang.createLibrary;
export const createParser = lang.createParser;
export const defineComponent = lang.defineComponent;
export const generatePrompt = lang.generatePrompt;
export const markReactive = lang.markReactive;
export const parseExpression = lang.parseExpression;
export const tokenize = lang.tokenize;
export const walkAST = lang.walkAST;
export type ASTNode = import("@openuidev/lang-core").ASTNode;
export type Library = import("@openuidev/lang-core").Library;
export type LibraryJSONSchema = import("@openuidev/lang-core").LibraryJSONSchema;
export type ParseResult = import("@openuidev/lang-core").ParseResult;
export type PromptOptions = import("@openuidev/lang-core").PromptOptions;
