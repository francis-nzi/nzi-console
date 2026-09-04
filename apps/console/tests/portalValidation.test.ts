import assert from "node:assert/strict";
import test from "node:test";
import type {PublishedCrpReportReadModel} from "@nzi/contracts";
import {isPortalIdentity,isPortalJobList} from "../app/portal/portalPortfolioValidation";
import {isPortalReportApproval,isPortalReportComment,isPublishedCrpReport,isThreadReadEvidence} from "../app/portal/jobs/[jobId]/publishedReportValidation";

const clone=<T>(value:T):T=>structuredClone(value);
const report:PublishedCrpReportReadModel={
  reportVersionId:"report-a",manifestVersion:1,publishedAt:"2026-08-27T12:00:00.000Z",dataHash:"sha256:report-a",
  snapshot:{id:"snapshot-a",jobId:"job-a",jobNumber:"J000712",client:"Synthetic Client",reportingYear:2026,version:1,jobVersion:4,createdAt:"2026-08-27T11:00:00.000Z",createdBy:"reviewer-a",dataHash:"sha256:report-a",
    target:{jobId:"job-a",baselineYear:2024,baselineTco2e:100,interimYear:2030,interimReductionPercent:50,netZeroYear:2045,version:1,updatedAt:"2026-08-27T10:00:00.000Z",updatedBy:"reviewer-a"},
    intensityTarget:{jobId:"job-a",metric:"employee",denominatorUnit:"FTE",reportingDenominator:10,baselineYear:2024,baselineIntensity:10,interimYear:2030,interimReductionPercent:50,netZeroYear:2045,version:1,updatedAt:"2026-08-27T10:00:00.000Z",updatedBy:"reviewer-a"},
    annualComparison:[{year:2026,sourceSnapshotId:"snapshot-a",sourceDataHash:"sha256:report-a",values:[{scope:"1",value:10},{scope:"2",value:20},{scope:"3",value:30}]}],
    sections:[],gapResolutions:[],
    measurements:[{rowId:"row-a",rowVersion:2,scope:"1",sourceLabel:"Synthetic fuel",tco2e:10,factorSet:"Synthetic factors v1",qualityTier:"measured",reviewedBy:"reviewer-a"}]}
};

test("accepts a coherent published report",()=>assert.equal(isPublishedCrpReport(report,"job-a"),true));
test("rejects cross-job publication evidence",()=>assert.equal(isPublishedCrpReport(report,"job-b"),false));
test("rejects duplicate measurement identities",()=>{const value=clone(report);value.snapshot.measurements.push(clone(value.snapshot.measurements[0]!));assert.equal(isPublishedCrpReport(value,"job-a"),false)});
test("rejects incomplete annual scope evidence",()=>{const value=clone(report);value.snapshot.annualComparison[0]!.values.pop();assert.equal(isPublishedCrpReport(value,"job-a"),false)});
test("rejects an invalid intensity denominator",()=>{const value=clone(report);value.snapshot.intensityTarget!.reportingDenominator=0;assert.equal(isPublishedCrpReport(value,"job-a"),false)});

const approval={approvalId:"approval-a",reportVersionId:"report-a",approvedAt:"2026-08-27T12:30:00.000Z",statementVersion:1 as const};
test("binds approval evidence to the exact report version",()=>{assert.equal(isPortalReportApproval(approval,"report-a"),true);assert.equal(isPortalReportApproval(approval,"report-b"),false)});
test("rejects unsupported approval statements",()=>assert.equal(isPortalReportApproval({...approval,statementVersion:2},"report-a"),false));

const comment={commentId:"comment-a",reportVersionId:"report-a",parentCommentId:null,authorPrincipal:"portal" as const,authorDisplayName:"Synthetic User",body:"Please clarify this result.",createdAt:"2026-08-27T12:35:00.000Z"};
test("binds comment evidence to version and author realm",()=>{assert.equal(isPortalReportComment(comment,"report-a","portal"),true);assert.equal(isPortalReportComment(comment,"report-b","portal"),false);assert.equal(isPortalReportComment(comment,"report-a","staff"),false)});
test("rejects blank comments and invalid receipts",()=>{assert.equal(isPortalReportComment({...comment,body:"   "},"report-a"),false);assert.equal(isThreadReadEvidence({lastReadAt:"not-a-date"}),false)});

test("accepts a coherent portal identity and portfolio",()=>{assert.equal(isPortalIdentity({userId:"user-a",clientId:"client-a",displayName:"Synthetic User",email:"user@example.test"}),true);assert.equal(isPortalJobList([{id:"job-a",number:"J000712",title:"Synthetic CRP",reportingYear:2026,hasPublishedReport:true,approved:true,approvedAt:"2026-08-27T12:30:00.000Z",hasUnreadNziResponse:false}]),true)});
test("rejects contradictory and duplicate portfolio states",()=>{const job={id:"job-a",number:"J000712",title:"Synthetic CRP",reportingYear:2026,hasPublishedReport:false,approved:true,approvedAt:"2026-08-27T12:30:00.000Z",hasUnreadNziResponse:false};assert.equal(isPortalJobList([job]),false);assert.equal(isPortalJobList([{...job,approved:false,approvedAt:null},{...job,approved:false,approvedAt:null}]),false)});
