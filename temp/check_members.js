import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { fetchClanMembers } from "../backend/services/clashApi.js";

const members = await fetchClanMembers("LRQP20V9");
console.log("count:", members.length);

for (const tag of ["#PRGCCRUJP", "#U9UGY99VC"]) {
  const m = members.find((m) => m.tag === tag);
  if (m) {
    console.log(tag, m.name, "role=" + m.role);
  } else {
    console.log(tag, "ABSENT du clan");
  }
}
