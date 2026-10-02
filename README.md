# Three-Block Week

A weekly planner for the Vision Baptist pastoral staff. Every day is split into Morning, Afternoon and Evening, and each block gets a type: Work · Office, Work · Remote, On-Going Education, Church Gathering, Family, or Rest. Work blocks hold objectives (with tasks under them) and standalone tasks. Each staff member plans their own week, and everyone can see the team's.

It's a plain website (no build step) that keeps its data in Supabase:

| File | What it is |
|---|---|
| `index.html` | The page and its styles |
| `app.js` | Everything the planner does |
| `config.js` | Your Supabase project URL and public key |
| `supabase/schema.sql` | Creates the database tables and the security rules |
| `api/` | The small server piece that talks to Basecamp |

---

## Setup

Plan on about an hour, mostly creating accounts. Do the steps in order.

### 1. Supabase (database and sign-in)

1. Create a free account at [supabase.com](https://supabase.com) and a new project called **Three-Block Week**. Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste in all of `supabase/schema.sql`, and click **Run**. This creates the tables and turns on live updates. Then add yourself to the staff list (see Managing staff below).
3. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key into `config.js`, or send both to Claude to do it. Both are meant to be public. Never share the `service_role` key.
4. Email sign-in links work right away. Google sign-in is step 2 below.

### 2. Google sign-in and Calendar (optional, recommended)

This lets staff sign in with Google and see their own Google Calendar events inside their blocks. Skip it and staff sign in with an emailed link instead. In that case, set `googleCalendar: false` in `config.js`.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project called **Three-Block Week**.
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**. App name: *Three-Block Week*. Add your email as support and developer contact.
   - **Scopes → Add** `.../auth/calendar.readonly`. The email, profile and openid scopes are already included.
   - **Test users → Add** every staff member's Google address. Up to 100 people can use the app while it's in testing mode.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**.
   - **Authorized redirect URI:** `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`. The project ref is the first part of your Supabase Project URL.
   - Copy the **Client ID** and **Client secret**.
5. In Supabase go to **Authentication → Sign In / Providers → Google**, turn it on, and paste in the Client ID and secret.

The first time someone signs in, Google may show a screen saying the app isn't verified, because it's in testing mode. They click **Continue**. Calendar access is read-only, and each person only ever sees their own calendar.

### 3. GitHub and Vercel (hosting)

1. The code lives in the GitHub repo `three-block-week`.
2. Create a free account at [vercel.com](https://vercel.com) using **Continue with GitHub**.
3. **Add New → Project →** import `three-block-week`. Leave Framework Preset as **Other**, with no build command and the root folder as-is. Click **Deploy**.
4. Vercel gives you an address like `three-block-week.vercel.app`. Every change pushed to GitHub redeploys automatically.

### 4. Tell Supabase where the site lives

In Supabase **Authentication → URL Configuration**:
- **Site URL:** your site address, e.g. `https://planner.visionbaptist.org`, or the vercel.app address for now.
- **Redirect URLs:** add `https://three-block-week.vercel.app/**` and, once it's set up, `https://planner.visionbaptist.org/**`.

Sign-in links and Google sign-in only return to addresses listed here.

### 5. Your own address (optional)

1. In Vercel go to **Project → Settings → Domains** and add `planner.visionbaptist.org`.
2. Vercel shows one DNS record to add, usually a **CNAME** pointing to `cname.vercel-dns.com`. Add it wherever visionbaptist.org's DNS is managed.
3. Add the new address to Supabase's Redirect URLs (step 4).

### 6. Bring over your Claude entries

Sign in to the new site once. Claude then imports the weeks you entered in the Claude version. That data is kept out of this repo on purpose.

### 7. Basecamp to-dos (optional)

This shows each person's assigned Basecamp to-dos in a tray inside the planner. You can plan any to-do into a block, and checking it off in either place checks it off in Basecamp.

1. Go to [launchpad.37signals.com/integrations](https://launchpad.37signals.com/integrations) and click **Register another application**.
   - Name: `Three-Block Week`. Company: `Vision Baptist Church`. Website: `https://three-block-week.vercel.app`.
   - Products: **Basecamp 4**.
   - Redirect URI: `https://three-block-week.vercel.app/api/basecamp/callback`
2. Basecamp then shows a **Client ID** and a **Client Secret**. In Vercel, open the project, go to **Settings → Environment Variables**, and add:
   - `BASECAMP_CLIENT_ID` with the Client ID
   - `BASECAMP_CLIENT_SECRET` with the Client Secret
3. Redeploy the project: **Deployments → … → Redeploy**.
4. In the planner, each person clicks **Connect Basecamp** once.

Each person's Basecamp access is encrypted and stored privately. No one else on staff can read it. **Disconnect** in the tray removes it.

---

## Managing staff

Only email addresses on the staff list can open the planner. In Supabase **SQL Editor**:

```sql
-- add someone
insert into public.staff (email) values ('name@example.org');

-- remove someone
delete from public.staff where email = 'name@example.org';
```

You can also use **Table Editor → staff**. If you're using Google sign-in, also add new people as test users in Google Cloud (step 2.3).

Everyone on the list can see everyone's week. Each person can only change their own.

## Costs

The free tiers of Supabase and Vercel should cover a staff this size. Supabase may pause a free project that goes about a week without use. Daily use keeps it awake, and you can resume it from the dashboard if it pauses. Free-tier limits change, so check current pricing.
