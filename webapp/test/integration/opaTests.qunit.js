/* global QUnit */
QUnit.config.autostart = false;

sap.ui.require(["projectmanagement/test/integration/AllJourneys"
], function () {
	QUnit.start();
});
