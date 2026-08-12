Deno.serve(async () => {
  const coreUrl = String(Deno.env.get("SITON_CORE_URL") || "").trim();

  return Response.json({
    ok: true,
    bridge: "siton-base44-migration",
    mode: "readiness-only",
    canonical_core_untouched: true,
    core_url_configured: Boolean(coreUrl),
    generated_at: new Date().toISOString()
  });
});
