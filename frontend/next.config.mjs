import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// node_modules is hoisted to the repo root by npm workspaces.
const workspaceRoot = join(__dirname, "..");


/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  turbopack: {
    root: workspaceRoot,
  },
 

  // The Next.js /api/[...path] route forwards API calls at runtime.
  // This works on Vercel without build-time rewrites or cross-site cookies.

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "*.supabase.in",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

export default nextConfig;
