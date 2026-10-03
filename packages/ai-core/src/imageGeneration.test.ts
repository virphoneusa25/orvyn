import assert from "node:assert/strict";
import test from "node:test";
import { decodeImageSource, imageAssetFailurePresentation, imageGenerationPresentation, imageGenerationView, markImageGenerationFailed, markImageGenerationReady, retryImageGeneration, type ImageElementLike, type ImageGenerationJob } from "./imageGeneration";

const asset = { artifactId: "art_1", name: "moon.png", mimeType: "image/png" };
const job = (status: ImageGenerationJob["status"], assets?: ImageGenerationJob["assets"]): ImageGenerationJob => ({ id: "img_1", prompt: "moon over mountains", status, assets });

test("queued and generating image jobs never present a final image or actions", () => {
  const queued = imageGenerationPresentation(job("queued"));
  const generating = imageGenerationPresentation(job("generating"));
  assert.equal(queued.view, "queued");
  assert.equal(queued.message, "Absolutely — I'm preparing that image for you.");
  assert.equal(queued.statusTitle, "Preparing image…");
  assert.equal(queued.showActions || queued.showRetry, false);
  assert.equal(generating.view, "generating");
  assert.equal(generating.message, "Absolutely — I'm creating that image for you.");
  assert.equal(generating.showActions || generating.showRetry, false);
});

test("provider completion stays finalizing until decoded, then becomes completed", () => {
  const finalizing = imageGenerationPresentation(job("provider-completed", [asset]));
  const completed = imageGenerationPresentation(job("completed", [asset]));
  assert.equal(finalizing.view, "finalizing");
  assert.equal(finalizing.message, "Finalizing your image…");
  assert.equal(finalizing.showActions, false);
  const ready = markImageGenerationReady(job("provider-completed", [asset]));
  assert.equal(imageGenerationView(ready), "completed");
  assert.equal(imageGenerationPresentation(ready).message, "Here's your image.");
  assert.equal(completed.showActions, true);
});

test("missing and failed image results produce a failure view", () => {
  assert.equal(imageGenerationView(job("provider-completed")), "failed");
  assert.equal(imageGenerationView(job("completed", [{ ...asset, artifactId: "" }])), "failed");
  assert.equal(imageGenerationPresentation(job("failed")).showRetry, true);
});

test("saved-image loading failure is distinct from provider generation failure", () => {
  const presentation = imageAssetFailurePresentation("The file took too long to load. Try again.");
  assert.equal(presentation.view, "asset-error");
  assert.equal(presentation.message, "Your image was generated, but I couldn't load it.");
  assert.equal(presentation.statusTitle, "The file took too long to load. Try again.");
  assert.equal(presentation.showActions, false);
  assert.equal(presentation.showRetry, true);
});

test("retry preserves the existing prompt and selected image model", () => {
  const failed = { ...job("failed"), modelId: "image-model-1" };
  assert.deepEqual(retryImageGeneration(failed), { prompt: "moon over mountains", modelId: "image-model-1" });
});

test("asset readiness waits for both onload and decode", async () => {
  let instance!: ImageElementLike;
  let decoded = false;
  const ready = decodeImageSource("blob:moon", () => {
    instance = {
      src: "",
      naturalWidth: 1024,
      naturalHeight: 768,
      onload: null,
      onerror: null,
      decode: async () => { await Promise.resolve(); decoded = true; },
    };
    return instance;
  });
  assert.equal(instance.src, "blob:moon");
  let settled = false;
  void ready.then(() => { settled = true; });
  instance.onload?.();
  await Promise.resolve();
  assert.equal(settled, false);
  await ready;
  assert.equal(decoded, true);
});

test("broken URLs and decode failures reject instead of marking ready", async () => {
  let image!: ImageElementLike;
  const broken = decodeImageSource("broken:", () => (image = { src: "", naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null }));
  image.onerror?.();
  await assert.rejects(broken);

  let decodeError!: ImageElementLike;
  const failedDecode = decodeImageSource("bad-decode:", () => (decodeError = {
    src: "", naturalWidth: 100, naturalHeight: 100, onload: null, onerror: null,
    decode: async () => { throw new Error("decode failed"); },
  }));
  decodeError.onload?.();
  await assert.rejects(failedDecode);
  const brokenJob = markImageGenerationFailed(job("provider-completed", [asset]), "The generated image could not be loaded.");
  assert.equal(imageGenerationView(brokenJob), "failed");
  assert.equal(imageGenerationView(brokenJob) === "completed", false);
});

test("image decoding has a finite timeout when the browser never fires load or error", async () => {
  const image: ImageElementLike = { src: "", naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null };
  await assert.rejects(decodeImageSource("stalled:", () => image, 5), /could not be loaded or decoded/i);
});
