import { Hono } from "hono";
import * as documentController from "../controllers/document.controller";

export const documentRoutes = new Hono();

documentRoutes.get("/", documentController.index);
documentRoutes.post("/", documentController.create);
// Registered before "/:id" so the literal paths are not captured as an id.
documentRoutes.get("/search", documentController.search);
documentRoutes.post("/transcribe", documentController.transcribe);
documentRoutes.get("/transcriptions", documentController.listTranscriptions);
documentRoutes.get("/transcriptions/:id", documentController.showTranscription);
documentRoutes.delete("/transcriptions/:id", documentController.destroyTranscription);
documentRoutes.delete("/:id", documentController.destroy);
