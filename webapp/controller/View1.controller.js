sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/format/DateFormat"
], (Controller, JSONModel, MessageToast, MessageBox, DateFormat) => {
    "use strict";

    const BATCH_GROUP = "$auto";

    return Controller.extend("projectmanagement.controller.View1", {
        _getODataModel: function () {
            const oComp = this.getOwnerComponent();
            // Use getModel() with no args to avoid "sModelName must be a string or omitted" when "" is not accepted
            return oComp.getModel();
        },

        _createEntry: function (oODataModel, sPath, oPayload) {
            // Use 2 args only so mParameters is not mistaken for aSorters (Unsupported sorter: [object Object])
            const oListBinding = oODataModel.bindList(sPath);
            const oContext = oListBinding.create();
            if (oPayload && oContext.setProperty) {
                Object.keys(oPayload).forEach(function (key) {
                    oContext.setProperty(key, oPayload[key]);
                });
            }
            return oContext;
        },

        _formatDateForOData: function (dateVal) {
            if (!dateVal) return null;
            const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
            if (isNaN(d.getTime())) return null;
            return d.toISOString().slice(0, 10);
        },

        onInit() {
            const oData = {
                activeTab: "projects",
                availableRoles: [],

                projects: [],
                resources: [],
                allocations: [],

                editingProjectId: null,
                editingResourceId: null,
                newCustomRole: "",
                newProject: { requiredRoles: [] },
                newResource: { roles: [] },
                newAllocation: { projectId: "" },
                newAllocationSlots: [],
                selectedProjectCapacity: 0,

                filters: { projectId: "", resourceId: "" },

                analytics: {
                    enrichedProjects: [], enrichedResources: [], projectionsByProject: [], projectionsByResource: [], summary: {}
                }
            };

            const oModel = new JSONModel(oData);
            this.getView().setModel(oModel);
            this._loadBackendData();
        },

        _loadBackendData: async function () {
            const oODataModel = this._getODataModel();
            const oViewModel = this.getView().getModel();

            const loadList = async (sPath) => {
                const oListBinding = oODataModel.bindList(sPath);
                const aContexts = await oListBinding.requestContexts();
                return aContexts.map((oCtx) => oCtx.getObject());
            };

            try {
                const [
                    aProjectsRaw,
                    aResourcesRaw,
                    aAllocationsRaw,
                    aProjectRolesRaw,
                    aResourceRolesRaw
                ] = await Promise.all([
                    loadList("/Projects"),
                    loadList("/Resources"),
                    loadList("/Allocations"),
                    loadList("/ProjectRoles"),
                    loadList("/ResourceRoles")
                ]);

                const mProjRolesByProject = {};
                aProjectRolesRaw.forEach((pr) => {
                    const sProjId = pr.project_ID;
                    if (!sProjId) {
                        return;
                    }
                    if (!mProjRolesByProject[sProjId]) {
                        mProjRolesByProject[sProjId] = [];
                    }
                    mProjRolesByProject[sProjId].push({
                        role: pr.role,
                        count: pr.count
                    });
                });

                const mResRolesByResource = {};
                aResourceRolesRaw.forEach((rr) => {
                    const sResId = rr.resource_ID;
                    if (!sResId) {
                        return;
                    }
                    if (!mResRolesByResource[sResId]) {
                        mResRolesByResource[sResId] = [];
                    }
                    mResRolesByResource[sResId].push(rr.role);
                });

                const aProjects = aProjectsRaw.map((p) => {
                    return {
                        id: p.ID,
                        name: p.name,
                        budget: Number(p.budget) || 0,
                        startDate: p.startDate,
                        endDate: p.endDate,
                        requiredRoles: mProjRolesByProject[p.ID] || []
                    };
                });

                const aResources = aResourcesRaw.map((r) => {
                    return {
                        id: r.ID,
                        name: r.name,
                        type: r.type,
                        salary: Number(r.salary) || 0,
                        officeCost: Number(r.officeCost) || 0,
                        overheadCost: Number(r.overheadCost) || 0,
                        hourlyRate: Number(r.hourlyRate) || 0,
                        roles: mResRolesByResource[r.ID] || []
                    };
                });

                const aAllocations = aAllocationsRaw.map((a) => {
                    return {
                        id: a.ID,
                        projectId: a.project_ID,
                        resourceId: a.resource_ID,
                        role: a.role,
                        hours: a.hours
                    };
                });

                const oRoleSet = new Set();
                aProjectRolesRaw.forEach((pr) => {
                    if (pr.role) {
                        oRoleSet.add(pr.role);
                    }
                });
                aResourceRolesRaw.forEach((rr) => {
                    if (rr.role) {
                        oRoleSet.add(rr.role);
                    }
                });

                oViewModel.setProperty("/projects", aProjects);
                oViewModel.setProperty("/resources", aResources);
                oViewModel.setProperty("/allocations", aAllocations);
                oViewModel.setProperty("/availableRoles", Array.from(oRoleSet));

                this._calculateAnalytics();
            } catch (e) {
                MessageToast.show("Failed to load data from service");
                // eslint-disable-next-line no-console
                console.error("Error loading data from CAP service", e);
            }
        },

        getWorkingHours: function (startStr, endStr) {
            if (!startStr || !endStr) return 0;
            const s = new Date(startStr);
            const e = new Date(endStr);
            if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) return 0;
            let count = 0;
            const cur = new Date(s);
            while (cur <= e) {
                const day = cur.getDay();
                if (day !== 0 && day !== 6) count++;
                cur.setDate(cur.getDate() + 1);
            }
            return count * 8;
        },

        _calculateAnalytics: function () {
            const oModel = this.getView().getModel();
            const data = oModel.getData();
            const MAX_HOURS = 2080;

            const enrichedProjects = data.projects.map(p => {
                let actualCost = 0;
                const standardCapacity = this.getWorkingHours(p.startDate, p.endDate);
                const assignedResources = data.allocations
                    .filter(a => a.projectId === p.id && a.resourceId) // Only include actual allocations with a valid resourceId
                    .map(a => {
                        const res = data.resources.find(r => r.id === a.resourceId);
                        if (res) actualCost += a.hours * res.hourlyRate;
                        const weekendHrs = Math.max(0, a.hours - standardCapacity);
                        return { name: res?.name || 'Unknown', role: a.role || 'Unassigned', hours: a.hours, weekendHrs: weekendHrs };
                    });
                return { ...p, assignedResources, actualCost, standardCapacity };
            });

            const enrichedResources = data.resources.map(r => {
                const assignedProjects = new Set();
                data.allocations.filter(a => a.resourceId === r.id).forEach(a => {
                    const p = data.projects.find(proj => proj.id === a.projectId);
                    if (p) assignedProjects.add(p.name);
                });
                return { ...r, assignedProjects: Array.from(assignedProjects).join(', ') || 'None' };
            });

            let projectionsByProject = data.projects.map(p => {
                let allocatedCost = 0;
                const activeResources = new Set();
                data.allocations.filter(a => a.projectId === p.id).forEach(alloc => {
                    const res = data.resources.find(r => r.id === alloc.resourceId);
                    if (res) {
                        allocatedCost += alloc.hours * res.hourlyRate;
                        activeResources.add(res.name);
                    }
                });
                const remaining = p.budget - allocatedCost;
                let statusState = "Success";
                if (remaining < 0) statusState = "Error"; else if (remaining < 10000) statusState = "Warning";
                return { ...p, allocatedCost, remaining, resourceCount: activeResources.size, statusState };
            });

            let projectionsByResource = data.resources.map(r => {
                let totalHours = 0, totalStandardHours = 0, totalWeekendHours = 0;
                const projectNames = new Set();
                const allocationsBreakdown = [];
                let colorIndex = 0;

                data.allocations.filter(a => a.resourceId === r.id).forEach(alloc => {
                    totalHours += alloc.hours;
                    const proj = data.projects.find(p => p.id === alloc.projectId);
                    if (proj) projectNames.add(proj.name);

                    const projCapacity = proj ? this.getWorkingHours(proj.startDate, proj.endDate) : 0;
                    totalStandardHours += Math.min(alloc.hours, projCapacity);
                    totalWeekendHours += Math.max(0, alloc.hours - projCapacity);

                    allocationsBreakdown.push({
                        projectName: proj ? proj.name : 'Unknown',
                        hours: alloc.hours,
                        percentage: ((alloc.hours / MAX_HOURS) * 100) + "%",
                        colorKey: String(colorIndex++ % 4) // <--- CHANGED THIS LINE
                    });
                });

                allocationsBreakdown.forEach(ab => {
                    if (totalHours > MAX_HOURS) ab.percentage = ((ab.hours / totalHours) * 100) + "%";
                });

                return {
                    ...r, totalHours, totalStandardHours, totalWeekendHours,
                    totalBilled: totalHours * r.hourlyRate,
                    projectsAssigned: Array.from(projectNames).join(', ') || 'None',
                    statusText: totalHours > MAX_HOURS ? "Over Occupied" : "Within Capacity",
                    statusState: totalHours > MAX_HOURS ? "Error" : "Success",
                    utilizationPercent: (totalHours / MAX_HOURS) * 100,
                    utilizationDisplay: `${Math.round((totalHours / MAX_HOURS) * 100)}%`,
                    allocationsBreakdown
                };
            });

            const totalBudget = data.projects.reduce((sum, p) => sum + p.budget, 0);
            const totalCost = projectionsByProject.reduce((sum, p) => sum + p.allocatedCost, 0);
            const totalCapacity = data.resources.length * 2080;
            const totalAllocatedHours = data.allocations.reduce((sum, a) => sum + a.hours, 0);

            const summary = {
                totalBudget, totalCost,
                budgetConsumption: totalBudget ? (totalCost / totalBudget) * 100 : 0,
                totalCapacity, totalAllocatedHours,
                hoursUtilization: totalCapacity ? (totalAllocatedHours / totalCapacity) * 100 : 0
            };

            if (data.filters.projectId) {
                projectionsByProject = projectionsByProject.filter(p => p.id === data.filters.projectId);
                projectionsByResource = projectionsByResource.filter(r => data.allocations.some(a => a.resourceId === r.id && a.projectId === data.filters.projectId));
            }
            if (data.filters.resourceId) {
                projectionsByProject = projectionsByProject.filter(p => data.allocations.some(a => a.projectId === p.id && a.resourceId === data.filters.resourceId));
                projectionsByResource = projectionsByResource.filter(r => r.id === data.filters.resourceId);
            }

            oModel.setProperty("/analytics/enrichedProjects", enrichedProjects);
            oModel.setProperty("/analytics/enrichedResources", enrichedResources);
            oModel.setProperty("/analytics/projectionsByProject", projectionsByProject);
            oModel.setProperty("/analytics/projectionsByResource", projectionsByResource);
            oModel.setProperty("/analytics/summary", summary);
        },

        onFilterChange: function () { this._calculateAnalytics(); },
        onClearFilters: function () {
            this.getView().getModel().setProperty("/filters", { projectId: "", resourceId: "" });
            this._calculateAnalytics();
        },

        _openDialog: function (sFragmentName) {
            const oView = this.getView();
            const sPath = "projectmanagement.view.fragments." + sFragmentName;

            if (!this["_p" + sFragmentName]) {
                this["_p" + sFragmentName] = this.loadFragment({ name: sPath }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    return oDialog;
                });
            }
            this["_p" + sFragmentName].then(function (oDialog) { oDialog.open(); });
        },

        onCloseDialog: function (oEvent) { oEvent.getSource().getParent().close(); },

        onAddProject: function () {
            const oModel = this.getView().getModel();
            const aProjects = oModel.getProperty("/projects") || [];
            let maxId = 0;
            aProjects.forEach(p => {
                const sId = (p.id || p.ID || "").toString();
                const numStr = sId.replace(/\D/g, "");
                if (numStr) {
                    const num = parseInt(numStr, 10);
                    if (num > maxId) maxId = num;
                }
            });
            const newId = `P${String(maxId + 1).padStart(3, '0')}`;
            oModel.setProperty("/editingProjectId", null);
            oModel.setProperty("/newProject", { id: newId, name: "", budget: null, startDate: "", endDate: "", requiredRoles: [] });
            this._openDialog("CreateProject");
        },

        onEditProject: function (oEvent) {
            const oItem = oEvent.getSource().getBindingContext().getObject();
            const oModel = this.getView().getModel();
            const itemCopy = JSON.parse(JSON.stringify(oItem));
            oModel.setProperty("/editingProjectId", itemCopy.id);
            oModel.setProperty("/newProject", itemCopy);
            this._openDialog("CreateProject");
        },

        onAddRoleToProject: function () {
            const roles = this.getView().getModel().getProperty("/newProject/requiredRoles") || [];
            roles.push({ role: "", count: 1 });
            this.getView().getModel().setProperty("/newProject/requiredRoles", roles);
        },

        onDeleteRoleFromProject: function (oEvent) {
            const path = oEvent.getSource().getBindingContext().getPath();
            const idx = parseInt(path.split("/").pop());
            const roles = this.getView().getModel().getProperty("/newProject/requiredRoles");
            roles.splice(idx, 1);
            this.getView().getModel().setProperty("/newProject/requiredRoles", roles);
        },

        onAddCustomRole: function () {
            const oModel = this.getView().getModel();
            const newRole = (oModel.getProperty("/newCustomRole") || "").trim();
            const availableRoles = oModel.getProperty("/availableRoles") || [];
            if (newRole && !availableRoles.includes(newRole)) {
                availableRoles.push(newRole);
                oModel.setProperty("/availableRoles", availableRoles);
            }
            oModel.setProperty("/newCustomRole", "");
        },

        onSaveProject: async function () {
            const oView = this.getView();
            const oModel = oView.getModel();
            const newProj = oModel.getProperty("/newProject");
            const editId = oModel.getProperty("/editingProjectId");

            if (!newProj.name || !newProj.startDate || !newProj.endDate) {
                MessageToast.show("Please fill required fields");
                return;
            }
            if (!newProj.budget) newProj.budget = 0;

            const oODataModel = this._getODataModel();
            const sProjectId = (newProj.id || "").toString().trim();
            const sPathProject = "/Projects('" + encodeURIComponent(sProjectId) + "')";

            try {
                if (editId) {
                    const oCtx = oODataModel.bindContext(sPathProject).getBoundContext();
                    oCtx.setProperty("name", newProj.name);
                    oCtx.setProperty("budget", parseFloat(newProj.budget) || 0);
                    oCtx.setProperty("startDate", this._formatDateForOData(newProj.startDate));
                    oCtx.setProperty("endDate", this._formatDateForOData(newProj.endDate));

                    const aExistingRoles = await this._loadProjectRolesForProject(oODataModel, sProjectId);
                    for (const oRoleCtx of aExistingRoles) {
                        if (oRoleCtx.delete) {
                            oRoleCtx.delete(BATCH_GROUP);
                        }
                    }
                    const requiredRoles = (newProj.requiredRoles || []).filter(r => r && r.role);
                    for (const r of requiredRoles) {
                        this._createEntry(oODataModel, "/ProjectRoles", {
                            project_ID: sProjectId,
                            role: r.role || "",
                            count: parseInt(r.count, 10) || 1
                        });
                    }
                } else {
                    this._createEntry(oODataModel, "/Projects", {
                        ID: sProjectId,
                        name: newProj.name,
                        budget: parseFloat(newProj.budget) || 0,
                        startDate: this._formatDateForOData(newProj.startDate),
                        endDate: this._formatDateForOData(newProj.endDate)
                    });
                    const requiredRoles = (newProj.requiredRoles || []).filter(r => r && r.role);
                    for (const r of requiredRoles) {
                        this._createEntry(oODataModel, "/ProjectRoles", {
                            project_ID: sProjectId,
                            role: r.role || "",
                            count: parseInt(r.count, 10) || 1
                        });
                    }
                }

                await oODataModel.submitBatch(BATCH_GROUP);
                this.byId("CreateProjectDialog").close();
                MessageToast.show(editId ? "Project Updated" : "Project Saved");
                await this._loadBackendData();
            } catch (e) {
                MessageToast.show(editId ? "Failed to update project" : "Failed to create project");
                // eslint-disable-next-line no-console
                console.error(e);
            }
        },

        _loadProjectRolesForProject: async function (oODataModel, sProjectId) {
            const oListBinding = oODataModel.bindList("/ProjectRoles");
            const aContexts = await oListBinding.requestContexts(0, 500);
            return aContexts.filter(function (oCtx) {
                const o = oCtx.getObject ? oCtx.getObject() : {};
                return o.project_ID === sProjectId;
            });
        },

        onDeleteProject: function (oEvent) {
            let oItem = oEvent.getSource();
            while (oItem && !oItem.getBindingContext) {
                oItem = oItem.getParent();
            }

            if (!oItem || !oItem.getBindingContext()) {
                MessageToast.show("Could not determine project to delete");
                return;
            }
            const oObj = oItem.getBindingContext().getObject();
            const sId = (oObj.id || oObj.ID || "").toString().trim();
            if (!sId) {
                MessageToast.show("Project ID not found");
                return;
            }

            // Store the project ID so the confirm handler can access it
            this._pendingDeleteProjectId = sId;

            const oView = this.getView();
            if (!this._pDeleteConfirmDialog) {
                this._pDeleteConfirmDialog = this.loadFragment({
                    name: "projectmanagement.view.fragments.DeleteConfirmation"
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    return oDialog;
                });
            }
            this._pDeleteConfirmDialog.then(function (oDialog) {
                oDialog.open();
            });
        },

        onDeleteProjectConfirm: async function () {
            // Close the dialog first
            this._pDeleteConfirmDialog.then(function (oDialog) {
                oDialog.close();
            });

            const sId = this._pendingDeleteProjectId;
            if (!sId) return;
            this._pendingDeleteProjectId = null;

            const oODataModel = this._getODataModel();
            try {
                // Delete associated Allocations
                const allocBinding = oODataModel.bindList("/Allocations");
                const allocContexts = await allocBinding.requestContexts(0, 1000);
                allocContexts.forEach(c => {
                    const o = c.getObject ? c.getObject() : {};
                    if (o.project_ID === sId && c.delete) {
                        c.delete(BATCH_GROUP);
                    }
                });

                // Delete associated ProjectRoles
                const roleBinding = oODataModel.bindList("/ProjectRoles");
                const roleContexts = await roleBinding.requestContexts(0, 1000);
                roleContexts.forEach(c => {
                    const o = c.getObject ? c.getObject() : {};
                    if (o.project_ID === sId && c.delete) {
                        c.delete(BATCH_GROUP);
                    }
                });

                const oListBinding = oODataModel.bindList("/Projects");
                const aContexts = await oListBinding.requestContexts(0, 500);
                const oCtx = aContexts.find(function (c) {
                    const o = c.getObject ? c.getObject() : {};
                    return (o.ID || o.id) === sId;
                });
                if (!oCtx) {
                    MessageToast.show("Project not found in service");
                    return;
                }
                if (oCtx.delete) {
                    oCtx.delete(BATCH_GROUP);
                } else {
                    MessageToast.show("Delete not supported");
                    return;
                }
                await oODataModel.submitBatch(BATCH_GROUP);
                MessageToast.show("Project Deleted");
                await this._loadBackendData();
            } catch (e) {
                MessageToast.show("Failed to delete project");
                // eslint-disable-next-line no-console
                console.error(e);
            }
        },

        onDeleteProjectCancel: function () {
            this._pendingDeleteProjectId = null;
            this._pDeleteConfirmDialog.then(function (oDialog) {
                oDialog.close();
            });
        },

        onAddResource: function () {
            const oModel = this.getView().getModel();
            const count = oModel.getProperty("/resources").length;
            oModel.setProperty("/editingResourceId", null);
            oModel.setProperty("/newResource", { id: `R00${count + 1}`, name: "", type: "Full Time", roles: [], salary: null, officeCost: null, overheadCost: null, hourlyRate: 0 });
            this._openDialog("CreateResource");
        },

        onEditResource: function (oEvent) {
            const oItem = oEvent.getSource().getBindingContext().getObject();
            const oModel = this.getView().getModel();
            const itemCopy = JSON.parse(JSON.stringify(oItem));
            oModel.setProperty("/editingResourceId", itemCopy.id);
            oModel.setProperty("/newResource", itemCopy);
            this._openDialog("CreateResource");
        },

        onResTypeChange: function () {
            const oModel = this.getView().getModel();
            if (oModel.getProperty("/newResource/type") === "Contract") {
                oModel.setProperty("/newResource/officeCost", 0);
                oModel.setProperty("/newResource/overheadCost", 0);
            }
            this.onCalcHourlyRate();
        },

        onCalcHourlyRate: function () {
            const oModel = this.getView().getModel();
            const res = oModel.getProperty("/newResource");
            const total = (parseFloat(res.salary) || 0) + (parseFloat(res.officeCost) || 0) + (parseFloat(res.overheadCost) || 0);
            oModel.setProperty("/newResource/hourlyRate", total > 0 ? Math.round(total / 2080) : 0);
        },

        isRoleSelected: function (sRole, aSelectedRoles) {
            if (!aSelectedRoles) return false;
            return aSelectedRoles.indexOf(sRole) !== -1;
        },

        onRoleSelectionChange: function (oEvent) {
            const bSelected = oEvent.getParameter("selected");
            const sRole = oEvent.getSource().getBindingContext().getObject();
            const oModel = this.getView().getModel();
            let aRoles = oModel.getProperty("/newResource/roles") || [];

            if (bSelected && aRoles.indexOf(sRole) === -1) {
                aRoles.push(sRole);
            } else if (!bSelected && aRoles.indexOf(sRole) !== -1) {
                aRoles = aRoles.filter(r => r !== sRole);
            }
            oModel.setProperty("/newResource/roles", aRoles);
        },

        onSaveResource: async function () {
            const oModel = this.getView().getModel();
            const newRes = oModel.getProperty("/newResource");
            const editId = oModel.getProperty("/editingResourceId");

            if (!newRes.name || !newRes.roles || newRes.roles.length === 0 || newRes.salary == null || newRes.salary === "") {
                MessageToast.show("Please fill required fields");
                return;
            }

            const oODataModel = this._getODataModel();
            const sResId = (newRes.id || "").toString().trim();
            const sPathResource = "/Resources('" + encodeURIComponent(sResId) + "')";

            try {
                if (editId) {
                    const oCtx = oODataModel.bindContext(sPathResource).getBoundContext();
                    oCtx.setProperty("name", newRes.name);
                    oCtx.setProperty("type", newRes.type || "Full Time");
                    oCtx.setProperty("salary", parseFloat(newRes.salary) || 0);
                    oCtx.setProperty("officeCost", parseFloat(newRes.officeCost) || 0);
                    oCtx.setProperty("overheadCost", parseFloat(newRes.overheadCost) || 0);
                    oCtx.setProperty("hourlyRate", parseFloat(newRes.hourlyRate) || 0);

                    const aExistingRoles = await this._loadResourceRolesForResource(oODataModel, sResId);
                    for (const oRoleCtx of aExistingRoles) {
                        if (oRoleCtx.delete) {
                            oRoleCtx.delete(BATCH_GROUP);
                        }
                    }
                    const roles = (newRes.roles || []);
                    for (const role of roles) {
                        if (role) {
                            this._createEntry(oODataModel, "/ResourceRoles", {
                                resource_ID: sResId,
                                role: typeof role === "string" ? role : (role.role || "")
                            });
                        }
                    }
                } else {
                    this._createEntry(oODataModel, "/Resources", {
                        ID: sResId,
                        name: newRes.name,
                        type: newRes.type || "Full Time",
                        salary: parseFloat(newRes.salary) || 0,
                        officeCost: parseFloat(newRes.officeCost) || 0,
                        overheadCost: parseFloat(newRes.overheadCost) || 0,
                        hourlyRate: parseFloat(newRes.hourlyRate) || 0
                    });
                    const roles = (newRes.roles || []);
                    for (const role of roles) {
                        if (role) {
                            this._createEntry(oODataModel, "/ResourceRoles", {
                                resource_ID: sResId,
                                role: typeof role === "string" ? role : (role.role || "")
                            });
                        }
                    }
                }

                await oODataModel.submitBatch(BATCH_GROUP);
                this.byId("CreateResourceDialog").close();
                MessageToast.show(editId ? "Resource Updated" : "Resource Saved");
                await this._loadBackendData();
            } catch (e) {
                MessageToast.show(editId ? "Failed to update resource" : "Failed to create resource");
                // eslint-disable-next-line no-console
                console.error(e);
            }
        },

        _loadResourceRolesForResource: async function (oODataModel, sResourceId) {
            const oListBinding = oODataModel.bindList("/ResourceRoles");
            const aContexts = await oListBinding.requestContexts(0, 500);
            return aContexts.filter(function (oCtx) {
                const o = oCtx.getObject ? oCtx.getObject() : {};
                return o.resource_ID === sResourceId;
            });
        },

        onDeleteResource: async function (oEvent) {
            let oItem = oEvent.getSource();
            while (oItem && !oItem.getBindingContext) {
                oItem = oItem.getParent();
            }

            if (!oItem || !oItem.getBindingContext()) {
                MessageToast.show("Could not determine resource to delete");
                return;
            }
            const oObj = oItem.getBindingContext().getObject();
            const sId = (oObj.id || oObj.ID || "").toString().trim();
            if (!sId) {
                MessageToast.show("Resource ID not found");
                return;
            }

            const oODataModel = this._getODataModel();
            try {
                const oListBinding = oODataModel.bindList("/Resources");
                const aContexts = await oListBinding.requestContexts(0, 500);
                const oCtx = aContexts.find(function (c) {
                    const o = c.getObject ? c.getObject() : {};
                    return (o.ID || o.id) === sId;
                });
                if (!oCtx) {
                    MessageToast.show("Resource not found in service");
                    return;
                }
                if (oCtx.delete) {
                    oCtx.delete(BATCH_GROUP);
                } else {
                    MessageToast.show("Delete not supported");
                    return;
                }
                await oODataModel.submitBatch(BATCH_GROUP);
                MessageToast.show("Resource Deleted");
                await this._loadBackendData();
            } catch (e) {
                MessageToast.show("Failed to delete resource");
                // eslint-disable-next-line no-console
                console.error(e);
            }
        },

        onAddAllocation: function () {
            this.getView().getModel().setProperty("/newAllocation", { projectId: "" });
            this.getView().getModel().setProperty("/newAllocationSlots", []);
            this.getView().getModel().setProperty("/selectedProjectCapacity", 0);
            this._openDialog("CreateAllocation");
        },

        onAllocProjectChange: function (oEvent) {
            const oSource = oEvent.getSource();
            const oSelectedItem = oEvent.getParameter("selectedItem");

            // Be defensive: fall back to selectedKey if selectedItem is not available
            const projectId = oSelectedItem ? oSelectedItem.getKey() : oSource.getSelectedKey();

            const oModel = this.getView().getModel();
            const proj = oModel.getProperty("/projects").find(p => p.id === projectId);

            // Store the selected project on the view model so onSaveAllocation can read it
            oModel.setProperty("/newAllocation/projectId", projectId);

            if (!projectId) {
                // eslint-disable-next-line no-console
                console.error("onAllocProjectChange: No projectId resolved from ComboBox", {
                    selectedItem: oSelectedItem,
                    selectedKey: oSource.getSelectedKey()
                });
                return;
            }

            if (!proj) {
                // eslint-disable-next-line no-console
                console.error("onAllocProjectChange: Project not found for id", projectId, "Projects:", oModel.getProperty("/projects"));
                return;
            }
            const existingAllocs = oModel.getProperty("/allocations").filter(a => a.projectId === projectId);

            oModel.setProperty("/selectedProjectCapacity", this.getWorkingHours(proj.startDate, proj.endDate));
            oModel.setProperty("/selectedProjectStartDate", proj.startDate);
            oModel.setProperty("/selectedProjectEndDate", proj.endDate);

            const slots = [];
            const fulfilledRoles = {};

            existingAllocs.forEach((alloc, idx) => {
                const isCustom = !proj.requiredRoles.some(req => req.role === alloc.role);
                slots.push({ id: `slot_ext_${idx}`, role: alloc.role || '', resourceId: alloc.resourceId, hours: alloc.hours, customRole: isCustom });
                if (alloc.role && !isCustom) fulfilledRoles[alloc.role] = (fulfilledRoles[alloc.role] || 0) + 1;
            });

            if (proj.requiredRoles) {
                proj.requiredRoles.forEach((req, idx) => {
                    const remaining = req.count - (fulfilledRoles[req.role] || 0);
                    for (let i = 0; i < remaining; i++) {
                        slots.push({ id: `slot_req_${idx}_${i}`, role: req.role, resourceId: "", hours: null, customRole: false });
                    }
                });
            }

            if (slots.length === 0) slots.push({ id: "slot_custom_0", role: "", resourceId: "", hours: null, customRole: true });
            oModel.setProperty("/newAllocationSlots", slots);
        },

        onAddAllocSlot: function () {
            const slots = this.getView().getModel().getProperty("/newAllocationSlots");
            slots.push({ id: `slot_custom_${Date.now()}`, role: "", resourceId: "", hours: null, customRole: true });
            this.getView().getModel().setProperty("/newAllocationSlots", slots);
        },

        onRemoveAllocSlot: function (oEvent) {
            const path = oEvent.getSource().getBindingContext().getPath();
            const idx = parseInt(path.split("/").pop());
            const slots = this.getView().getModel().getProperty("/newAllocationSlots");
            slots.splice(idx, 1);
            this.getView().getModel().setProperty("/newAllocationSlots", slots);
        },

        onSaveAllocation: async function () {
            const oModel = this.getView().getModel();

            try {
                const projectId = oModel.getProperty("/newAllocation/projectId");
                const slots = oModel.getProperty("/newAllocationSlots");

                // 1) Must have a project
                if (!projectId) {
                    // eslint-disable-next-line no-console
                    console.error("onSaveAllocation: No projectId set on /newAllocation", oModel.getProperty("/newAllocation"));
                    MessageToast.show("Please select a project");
                    return;
                }

                // 2) Must have at least one slot row
                if (!Array.isArray(slots) || !slots.length) {
                    // eslint-disable-next-line no-console
                    console.error("onSaveAllocation: No allocation slots available", slots);
                    MessageToast.show("Please assign at least one resource with hours");
                    return;
                }

                // 3) Each saved row must have a resource + hours > 0
                const validSlots = slots.filter(s => s.resourceId && parseInt(s.hours, 10) > 0);
                if (!validSlots.length) {
                    // eslint-disable-next-line no-console
                    console.error("onSaveAllocation: No valid slots (need resourceId and hours > 0). Current slots:", slots);
                    MessageToast.show("Please assign at least one resource with hours");
                    return;
                }

                const oODataModel = this._getODataModel();
                const sProjectId = String(projectId).trim();

                // 4) Delete existing allocations for this project (in backend)
                const oAllocListBinding = oODataModel.bindList("/Allocations");
                const aAllocContexts = await oAllocListBinding.requestContexts(0, 500);
                const aExistingForProject = aAllocContexts.filter(function (c) {
                    const o = c.getObject ? c.getObject() : {};
                    return (o.project_ID || o.projectId) === sProjectId;
                });

                for (const oCtx of aExistingForProject) {
                    if (oCtx.delete) {
                        oCtx.delete(BATCH_GROUP);
                    }
                }

                // 5) Create new allocations from the current slots (in backend)
                for (const s of validSlots) {
                    this._createEntry(oODataModel, "/Allocations", {
                        project_ID: sProjectId,
                        resource_ID: String(s.resourceId).trim(),
                        role: (s.role || "").toString(),
                        hours: parseInt(s.hours, 10) || 0
                    });
                }

                // 6) Submit the batch, close dialog, and reload data
                await oODataModel.submitBatch(BATCH_GROUP);
                this.byId("CreateAllocationDialog").close();
                MessageToast.show("Allocations Updated");
                await this._loadBackendData();

            } catch (e) {
                MessageToast.show("Failed to save allocations");
                // eslint-disable-next-line no-console
                console.error("Error in onSaveAllocation", e);
            }
        },

        formatCurrency: function (value) {
            if (value === null || value === undefined) return "";
            // Changed formatting to include .00 exactly like your images
            return parseFloat(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },

        formatDate: function (dateStr) {
            if (!dateStr) return "";
            const oDate = new Date(dateStr);
            return DateFormat.getDateInstance({ style: "medium" }).format(oDate);
        }
    });
});