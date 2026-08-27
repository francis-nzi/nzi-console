import assert from "node:assert/strict";
import {it} from "node:test";
import type {PublishedCrpReportReadModel} from "@nzi/contracts";
import {portalDeliverableKinds,portalDeliverableRecords} from "../src/index";

const report={reportVersionId:"report-v4",manifestVersion:1,publishedAt:"2026-09-04T10:00:00.000Z",dataHash:"a".repeat(64),snapshot:{id:"snapshot-v4",jobId:"job-a",jobNumber:"J000900",client:"Example Client",reportingYear:2025,version:4,jobVersion:8,createdAt:"2026-09-03T10:00:00.000Z",createdBy:"reviewer-a",dataHash:"a".repeat(64),target:null,intensityTarget:null,annualComparison:[],measurements:[]}} as PublishedCrpReportReadModel;

it("exposes exactly three PDF records bound to one immutable publication",()=>{const documents=portalDeliverableRecords(report);assert.deepEqual(documents.map(item=>item.kind),["report","certificate","methodology"]);assert.equal(new Set(documents.map(item=>item.documentId)).size,3);for(const document of documents){assert.equal(document.reportVersionId,report.reportVersionId);assert.equal(document.snapshotId,report.snapshot.id);assert.equal(document.evidenceHash,report.dataHash);assert.equal(document.contentType,"application/pdf");assert.ok(document.filename.endsWith(`-${report.reportVersionId}.pdf`));}});
it("accepts only supported portal deliverable routes",()=>{for(const kind of ["report","certificate","methodology"])assert.equal(portalDeliverableKinds(kind),true);for(const kind of ["","invoice","../report"])assert.equal(portalDeliverableKinds(kind),false);});
