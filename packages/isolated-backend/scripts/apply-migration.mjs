import {readFileSync} from "node:fs";
import pg from "pg";

const migration=process.argv[2];
if(!migration)throw new Error("Migration path is required.");
if(process.env.NEXT_PUBLIC_APP_ENV==="production"||process.env.NZI_DATABASE_BOUNDARY!=="isolated-non-production")throw new Error("Only the confirmed isolated non-production database is allowed.");
const connectionString=process.env.NZI_ISOLATED_DATABASE_URL;
if(!connectionString)throw new Error("NZI_ISOLATED_DATABASE_URL is required.");
const client=new pg.Client({connectionString,ssl:{rejectUnauthorized:false}});
await client.connect();
try{await client.query(readFileSync(migration,"utf8"));console.log(`Applied ${migration}`)}finally{await client.end()}
