import { searchBible } from "@/lib/bible/index";
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

  const { searchParams } = request.nextUrl;
  const term = (searchParams.get("term") ?? searchParams.get("q") ?? "").trim();

  if (!term) {
    return NextResponse.json(
      { error: "Missing search term. Provide `term` or `q` query parameter." },
      { status: 400 },
    );
  }

  const maybeLimit = parseNumberParam(searchParams.get("limit"), "limit");
  if (maybeLimit instanceof Error) {
    return NextResponse.json({ error: maybeLimit.message }, { status: 400 });
  }

  const maybeMaxResults = parseNumberParam(
    searchParams.get("maxResults"),
    "maxResults",
  );
  if (maybeMaxResults instanceof Error) {
    return NextResponse.json(
      { error: maybeMaxResults.message },
      { status: 400 },
    );
  }

  const translationParam = searchParams.get("translation") ?? undefined;

  try {
    const results = await searchBible({
      term,
      limit: maybeLimit ?? undefined,
      maxResults: maybeMaxResults ?? undefined,
      translation: translationParam ?? undefined,
    });

    return NextResponse.json({
      term,
      translation: translationParam ?? undefined,
      results,
    });
  } catch (error) {
    console.error("Bible search failed", error);
    return NextResponse.json(
      { error: "Unable to complete Bible search." },
      { status: 500 },
    );
  }
}

function parseNumberParam(
  value: string | null,
  key: string,
): number | Error | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return new Error(`Query parameter \`${key}\` must be a finite number.`);
  }

  if (!Number.isInteger(parsed)) {
    return new Error(`Query parameter \`${key}\` must be an integer.`);
  }

  if (parsed < 0) {
    return new Error(`Query parameter \`${key}\` cannot be negative.`);
  }

  return parsed;
}
