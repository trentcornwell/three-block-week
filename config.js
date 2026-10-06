// Three-Block Week — connection settings.
// Values from Supabase → Project Settings → API Keys (the publishable key).
// Both are designed to be public (they ship to every browser). Never put the service_role key here.
(typeof window !== "undefined" ? window : globalThis).TBW_CONFIG = {
  supabaseUrl: "https://roaxulhdehqwqcjefxce.supabase.co",
  supabaseAnonKey: "sb_publishable_Pg7EXQgFfUdYuWfLA1gImg_-1IsPOGw",
  googleCalendar: true   // set to false to hide the Google Calendar feature
};
if (typeof module !== "undefined") module.exports = globalThis.TBW_CONFIG || window.TBW_CONFIG;
