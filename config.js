// Squeek Picks settings. Updating index.html never touches this file.
window.SQUEEK_CONFIG = {
  // Supabase, for the free points game (Project Settings > API).
  SUPABASE_URL: "https://ckmrseoqpxwpvhmitmre.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbXJzZW9xcHh3cHZobWl0bXJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwNDM0MDUsImV4cCI6MjEwODYxOTQwNX0.Z-icQ9xqr6za7GFEaMNfkLllmA1p0Xg7f72FQLZtTrE",   // paste your anon key (the long one starting with eyJ)

  // The nightly pot on Sepolia, deployed from index.html?admin
  POT_ADDRESS: "0x10fC2c8CCe2FFAceb619c3F1A1E38e253264B81B",

  // Reown project for the wallet picker (dashboard.reown.com). Public by design;
  // the project's allowed domain is what stops other sites using it.
  REOWN_PROJECT_ID: "33e4c95be5c69df8c0651de82a7a1288",

  // Optional: a different Sepolia RPC endpoint for reading the pot.
  // RPC_URL: "https://ethereum-sepolia-rpc.publicnode.com",
};
