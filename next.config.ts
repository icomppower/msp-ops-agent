import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The driver and libmongocrypt are native/Node-only; keep them out of the bundler.
  serverExternalPackages: ["mongodb", "mongodb-client-encryption", "@huggingface/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
