async function verify() {
  const baseUrl = "http://localhost:8000";
  console.log("Running verification on", baseUrl);

  try {
    // 1. Root
    const rootRes = await fetch(`${baseUrl}/`);
    console.log("GET / status:", rootRes.status);
    if (!rootRes.ok) throw new Error("Root failed");

    // 2. Rounds
    const roundsRes = await fetch(`${baseUrl}/rounds?limit=1`);
    console.log("GET /rounds status:", roundsRes.status);
    if (!roundsRes.ok) {
      const text = await roundsRes.text();
      console.error("GET /rounds failed:", text);
      throw new Error("Rounds failed");
    }
    const roundsData = await roundsRes.json();
    console.log("GET /rounds data type:", typeof roundsData);

    // 3. Strategies (mock user)
    const strategiesRes = await fetch(`${baseUrl}/strategies`, {
      headers: { "x-user-id": "test-user" },
    });
    console.log("GET /strategies status:", strategiesRes.status);
    if (!strategiesRes.ok) {
      const text = await strategiesRes.text();
      console.error("GET /strategies failed:", text);
      throw new Error("Strategies failed");
    }
    const strategiesData = await strategiesRes.json();
    console.log(
      "GET /strategies success, items:",
      Array.isArray(strategiesData) ? strategiesData.length : "Not array",
    );

    console.log("✅ Verification Passed!");
  } catch (error) {
    console.error("❌ Verification Failed:", error);
    process.exit(1);
  }
}

verify();
