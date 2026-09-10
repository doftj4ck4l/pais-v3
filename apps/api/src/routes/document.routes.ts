import { Hono } from "hono";
import * as documentController from "../controllers/document.controller";

export const documentRoutes = new Hono();

documentRoutes.get("/", documentController.index);
documentRoutes.post("/", documentController.create);
// Registered before "/:id" so the literal paths are not captured as an id.
documentRoutes.get("/search", documentController.search);
documentRoutes.post("/transcribe", documentController.transcribe);
documentRoutes.post("/transcription-uploads", documentController.createTranscriptionUpload);
documentRoutes.put("/transcription-uploads/:id/chunks/:part", documentController.appendTranscriptionUpload);
documentRoutes.post("/transcription-uploads/:id/complete", documentController.completeTranscriptionUpload);
documentRoutes.delete("/transcription-uploads/:id", documentController.destroyTranscriptionUpload);
documentRoutes.get("/transcriptions", documentController.listTranscriptions);
documentRoutes.get("/transcriptions/:id/transcript", documentController.transcript);
documentRoutes.get("/transcriptions/:id", documentController.showTranscription);
documentRoutes.delete("/transcriptions/:id", documentController.destroyTranscription);
documentRoutes.delete("/:id", documentController.destroy);
