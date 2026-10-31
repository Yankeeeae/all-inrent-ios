import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";

const email = String(process.env.AIR_REVIEW_EMAIL || "")
  .trim()
  .toLowerCase();
const password = String(process.env.AIR_REVIEW_PASSWORD || "");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !password || !url || !key) {
  console.error("missing_env");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const passwordHash = await bcrypt.hash(password, 12);

const { data: existing } = await supabase
  .from("gg_agency_users")
  .select("id, agency_id")
  .eq("email", email)
  .maybeSingle();

if (existing?.id) {
  const { error } = await supabase
    .from("gg_agency_users")
    .update({
      password_hash: passwordHash,
      is_active: true,
      role: "owner",
      full_name: "App Review",
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  await supabase
    .from("gg_agencies")
    .update({
      portal_status: "active",
      owner_email: email,
      onboarding_completed_at: new Date().toISOString(),
    })
    .eq("id", existing.agency_id);
  console.log("updated");
  process.exit(0);
}

const slug = "apple-review-pro";
const agencyPayload = {
  name: "ALL IN RENT Review",
  slug,
  city: "Paris",
  owner_email: email,
  owner_name: "App Review",
  portal_status: "active",
  is_demo: true,
  is_verified: false,
  is_featured: false,
  rating: 0,
  review_count: 0,
  onboarding_completed_at: new Date().toISOString(),
  description: "Compte App Review — non public.",
  business_details: {
    legalName: "ALL IN RENT Review SAS",
    siret: "12345678901234",
    address: "10 rue de la Paix",
    postalCode: "75002",
    city: "Paris",
    country: "FR",
    phone: "+33100000000",
    email,
  },
};

let agencyId = null;
const first = await supabase.from("gg_agencies").insert(agencyPayload).select("id").single();
if (!first.error && first.data) {
  agencyId = first.data.id;
} else {
  delete agencyPayload.is_demo;
  const retry = await supabase.from("gg_agencies").insert(agencyPayload).select("id").single();
  if (retry.error || !retry.data) {
    console.error(first.error?.message || retry.error?.message || "agency_insert");
    process.exit(1);
  }
  agencyId = retry.data.id;
}

const user = await supabase
  .from("gg_agency_users")
  .insert({
    agency_id: agencyId,
    email,
    password_hash: passwordHash,
    full_name: "App Review",
    role: "owner",
    is_active: true,
  })
  .select("id")
  .single();

if (user.error) {
  console.error(user.error.message);
  process.exit(1);
}

console.log("created");
