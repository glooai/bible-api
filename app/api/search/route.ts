import { NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.API_KEY;

export async function GET(request: NextRequest) {
  if (!API_KEY) {
    console.error("API_KEY environment variable is not set");

    return NextResponse.json(
      { error: "Server misconfiguration: missing API key" },
      { status: 500 },
    );
  }

  const providedKey = request.headers.get("x-api-key");

  if (!providedKey || providedKey !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    message: "Search endpoint placeholder",
    results: [],
  });
}
