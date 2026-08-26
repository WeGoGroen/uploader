import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "DROPBOX_CLIENT_ID is not configured" },
      { status: 500 }
    );
  }

  const redirectUri = new URL(
    "/api/auth/dropbox/callback",
    request.url
  ).toString();

  const authorizeUrl = new URL("https://www.dropbox.com/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  // offline access issues a refresh_token, so the connection survives past
  // the ~4h access token expiry without asking the user to log in again.
  authorizeUrl.searchParams.set("token_access_type", "offline");

  return NextResponse.redirect(authorizeUrl.toString());
}
