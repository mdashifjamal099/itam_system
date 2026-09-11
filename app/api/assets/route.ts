import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/tenant";
import { getActor, requireRole } from "@/lib/auth";
import { toErrorResponse } from "@/lib/http";

export async function POST(req: NextRequest) {
  try {
    const actor = requireRole(await getActor(), "ASSET_ADMIN", "SUPER_ADMIN");
    const {
      assetTag,
      serialNumber,
      category,
      model,
      vendor,
      procurementDate,
      warrantyExpiry,
      location,
    } = (await req.json()) as {
      assetTag?: string;
      serialNumber?: string;
      category?: string;
      model?: string;
      vendor?: string;
      procurementDate?: string;
      warrantyExpiry?: string;
      location?: string;
    };

    if (!assetTag || !serialNumber || !category || !model) {
      return NextResponse.json(
        { error: "assetTag, serialNumber, category, and model are required" },
        { status: 400 },
      );
    }

    const rows = await withTenant<{ result: Record<string, unknown> }>(
      actor.org_id,
      sql`SELECT fn_create_asset(
            ${actor.org_id}::uuid, ${actor.id}::uuid, ${assetTag}, ${serialNumber},
            ${category}, ${model}, ${vendor ?? null},
            ${procurementDate ?? null}::date, ${warrantyExpiry ?? null}::date, ${location ?? null}
          ) AS result`,
    );

    return NextResponse.json(rows[0].result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("duplicate key")) {
      return NextResponse.json(
        { error: "An asset with this tag or serial number already exists" },
        { status: 409 },
      );
    }
    return toErrorResponse(err);
  }
}
