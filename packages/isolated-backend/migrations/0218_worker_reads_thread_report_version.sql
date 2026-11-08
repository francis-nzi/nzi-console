-- 0218 The notification worker may read which report version a thread belongs to (client-review loop F3).
--
-- A message-notification email links the client to the message. A report-review round's thread (`thr-rv-<version>`, 0201) is read and answered on the
-- portal's review page, not the Messages page, so the worker must know that a thread is a report thread. The thread already says so itself:
-- `portal_threads.report_version_id` is set on those threads and null on every conversation. 0206 granted the worker the thread's columns one by one
-- - `report_version_id` is not among them - so the scan's join cannot read it.
--
-- This grants that one column, SELECT only. It lets the worker see which version a thread is tied to; it gives it no way to read the report (it has no
-- grant on `report_versions`), to change the thread, or to see any message text. The link the email carries is still just an address.
GRANT SELECT (report_version_id) ON nzi_console.portal_threads TO nzi_console_worker;
