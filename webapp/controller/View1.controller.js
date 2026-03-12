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
                },

                uiState: {
                    showNewTemplate: false,
                    newTemplateName: "New Custom Template",
                    editingTemplatePath: null,
                    editingTemplateId: null
                },

                templates: [],

                wbsTasks: [],
                wbsTasksForSelectedProject: [],
                wbsSelectedProjectId: "",
                wbsImportTemplateId: "",

                timelineSelectedProjectId: "",
                timelineActiveSection: "tasks",
                timelineData: { tasks: [], weeks: [] },
                timelineResourceData: []
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
                    aResourceRolesRaw,
                    aTemplatesRaw,
                    aTemplatePhasesRaw,
                    aTemplateTasksRaw,
                    aWbsTasksRaw
                ] = await Promise.all([
                    loadList("/Projects"),
                    loadList("/Resources"),
                    loadList("/Allocations"),
                    loadList("/ProjectRoles"),
                    loadList("/ResourceRoles"),
                    loadList("/Templates"),
                    loadList("/TemplatePhases"),
                    loadList("/TemplateTasks"),
                    loadList("/WBSTasks")
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

                // Read the persisted project→template mapping from localStorage
                let mProjectTemplateMap = {};
                try {
                    mProjectTemplateMap = JSON.parse(localStorage.getItem("projectTemplateMap") || "{}");
                } catch (ignore) { }

                const aProjects = aProjectsRaw.map((p) => {
                    return {
                        id: p.ID,
                        name: p.name,
                        budget: Number(p.budget) || 0,
                        startDate: p.startDate,
                        endDate: p.endDate,
                        templateId: mProjectTemplateMap[p.ID] || "",
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

                // --- Assemble Templates with nested phases and tasks ---
                const mTasksByPhase = {};
                aTemplateTasksRaw.forEach((tt) => {
                    const sPhaseId = tt.phase_ID;
                    if (!sPhaseId) return;
                    if (!mTasksByPhase[sPhaseId]) mTasksByPhase[sPhaseId] = [];
                    mTasksByPhase[sPhaseId].push({
                        id: tt.ID,
                        name: tt.name,
                        role: tt.role,
                        defaultHours: tt.defaultHours,
                        sequence: tt.sequence
                    });
                });

                const mPhasesByTemplate = {};
                aTemplatePhasesRaw.forEach((tp) => {
                    const sTplId = tp.template_ID;
                    if (!sTplId) return;
                    if (!mPhasesByTemplate[sTplId]) mPhasesByTemplate[sTplId] = [];
                    const phaseTasks = (mTasksByPhase[tp.ID] || []).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
                    mPhasesByTemplate[sTplId].push({
                        id: tp.ID,
                        name: tp.name,
                        sequence: tp.sequence,
                        tasks: phaseTasks
                    });
                });

                const aTemplates = aTemplatesRaw.map((t) => {
                    const phases = (mPhasesByTemplate[t.ID] || []).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
                    return {
                        id: t.ID,
                        name: t.name,
                        phases: phases
                    };
                });

                // --- Map WBSTasks to local format ---
                const aWbsTasks = aWbsTasksRaw.map((w) => {
                    return {
                        id: w.ID,
                        projectId: w.project_ID,
                        phaseName: w.phaseName,
                        name: w.name,
                        role: w.role,
                        resourceId: w.resource_ID || '',
                        hours: w.hours,
                        startDate: w.startDate,
                        endDate: w.endDate,
                        status: w.status || 'Not Started',
                        sequence: w.sequence,
                        predecessor: w.predecessor_ID || ''
                    };
                });

                oViewModel.setProperty("/projects", aProjects);
                oViewModel.setProperty("/resources", aResources);
                oViewModel.setProperty("/allocations", aAllocations);
                oViewModel.setProperty("/availableRoles", Array.from(oRoleSet));
                oViewModel.setProperty("/templates", aTemplates);
                oViewModel.setProperty("/wbsTasks", aWbsTasks);

                this._calculateAnalytics();
                this._computeWbsTasks();
                this._computeTimelineData();
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

                const template = data.templates.find(t => t.id === p.templateId);
                const templateName = template ? template.name : "None";

                return { ...p, assignedResources, actualCost, standardCapacity, templateName };
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
                
                // Calculate allocated hours from the Work Breakdown Structure
                const allocatedPlanHours = data.wbsTasks
                    .filter(t => t.projectId === p.id)
                    .reduce((sum, t) => sum + (t.hours || 0), 0);

                const remaining = p.budget - allocatedCost;
                let statusState = "Success";
                if (remaining < 0) statusState = "Error"; else if (remaining < 10000) statusState = "Warning";
                return { ...p, allocatedCost, remaining, resourceCount: activeResources.size, statusState, allocatedPlanHours };
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
            // Sum the total standard hours capacity across all active projects' timelines
            const totalCapacity = enrichedProjects.reduce((sum, p) => sum + (p.standardCapacity || 0), 0);
            // Sum the new allocatedPlanHours (from WBS tasks) across all projects
            const totalAllocatedHours = projectionsByProject.reduce((sum, p) => sum + (p.allocatedPlanHours || 0), 0);

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
            oModel.setProperty("/newProject", { id: newId, name: "", budget: null, startDate: "", endDate: "", requiredRoles: [], templateId: "" });
            this._openDialog("CreateProject");
        },

        onEditProject: function (oEvent) {
            const oItem = oEvent.getSource().getBindingContext().getObject();
            const oModel = this.getView().getModel();
            const itemCopy = JSON.parse(JSON.stringify(oItem));
            // Read templateId from localStorage if not already set on item
            if (!itemCopy.templateId) {
                try {
                    const mMap = JSON.parse(localStorage.getItem("projectTemplateMap") || "{}");
                    itemCopy.templateId = mMap[itemCopy.id] || "";
                } catch (ignore) { }
            }
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
                // Save the template association to localStorage (backend schema has no template_ID on Projects)
                const mProjectTemplateMap = JSON.parse(localStorage.getItem("projectTemplateMap") || "{}");
                if (newProj.templateId) {
                    mProjectTemplateMap[sProjectId] = newProj.templateId;
                } else {
                    delete mProjectTemplateMap[sProjectId];
                }
                localStorage.setItem("projectTemplateMap", JSON.stringify(mProjectTemplateMap));

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

        // --- Template UI Logic ---
        onAddNewTemplate: function () {
            const oModel = this.getView().getModel();
            oModel.setProperty("/uiState/editingTemplatePath", null);
            oModel.setProperty("/uiState/editingTemplateId", null);
            oModel.setProperty("/uiState/newTemplateName", "New Custom Template");
            oModel.setProperty("/uiState/editingTemplatePhases", []);
            oModel.setProperty("/uiState/showNewTemplate", true);
        },

        onEditTemplate: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            if (!oContext) return;
            const oTemplate = oContext.getObject();
            const sPath = oContext.getPath();

            this.getView().getModel().setProperty("/uiState/editingTemplatePath", sPath);
            this.getView().getModel().setProperty("/uiState/editingTemplateId", oTemplate.id);
            this.getView().getModel().setProperty("/uiState/newTemplateName", oTemplate.name);
            this.getView().getModel().setProperty("/uiState/editingTemplatePhases", JSON.parse(JSON.stringify(oTemplate.phases || [])));
            this.getView().getModel().setProperty("/uiState/showNewTemplate", true);
        },

        onSaveTemplate: async function () {
            const oModel = this.getView().getModel();
            const sName = oModel.getProperty("/uiState/newTemplateName") || "Untitled Template";
            const sEditPath = oModel.getProperty("/uiState/editingTemplatePath");
            const aPhases = oModel.getProperty("/uiState/editingTemplatePhases") || [];
            const oODataModel = this._getODataModel();

            try {
                if (sEditPath) {
                    // --- Editing existing template ---
                    const oTemplate = oModel.getProperty(sEditPath);
                    const sTemplateId = oTemplate.id;

                    // Update template name
                    const oTplCtx = oODataModel.bindContext("/Templates('" + encodeURIComponent(sTemplateId) + "')").getBoundContext();
                    oTplCtx.setProperty("name", sName);

                    // Delete existing phases and tasks
                    const aExistingPhases = await this._loadTemplatePhasesForTemplate(oODataModel, sTemplateId);
                    for (const oPhaseCtx of aExistingPhases) {
                        const phaseObj = oPhaseCtx.getObject ? oPhaseCtx.getObject() : {};
                        // Delete tasks belonging to this phase
                        const aExistingTasks = await this._loadTemplateTasksForPhase(oODataModel, phaseObj.ID);
                        for (const oTaskCtx of aExistingTasks) {
                            if (oTaskCtx.delete) oTaskCtx.delete(BATCH_GROUP);
                        }
                        if (oPhaseCtx.delete) oPhaseCtx.delete(BATCH_GROUP);
                    }

                    // Re-create phases and tasks
                    aPhases.forEach((phase, pIdx) => {
                        const oPhaseCtx = this._createEntry(oODataModel, "/TemplatePhases", {
                            template_ID: sTemplateId,
                            name: phase.name,
                            sequence: pIdx + 1
                        });
                        // We need to submit phases first to get IDs, so we use a simpler approach:
                        // Create tasks referencing phase via a temporary approach
                    });

                    await oODataModel.submitBatch(BATCH_GROUP);

                    // Now load the newly created phases to get their IDs, then create tasks
                    const aNewPhaseCtxs = await this._loadTemplatePhasesForTemplate(oODataModel, sTemplateId);
                    const sortedNewPhases = aNewPhaseCtxs.map(c => c.getObject()).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

                    for (let pIdx = 0; pIdx < aPhases.length && pIdx < sortedNewPhases.length; pIdx++) {
                        const phase = aPhases[pIdx];
                        const backendPhase = sortedNewPhases[pIdx];
                        if (phase.tasks) {
                            phase.tasks.forEach((task, tIdx) => {
                                this._createEntry(oODataModel, "/TemplateTasks", {
                                    phase_ID: backendPhase.ID,
                                    name: task.name,
                                    role: task.role || '',
                                    defaultHours: parseInt(task.defaultHours) || 8,
                                    sequence: tIdx + 1
                                });
                            });
                        }
                    }

                    await oODataModel.submitBatch(BATCH_GROUP);
                    MessageToast.show("Template Updated successfully");
                } else {
                    // --- Creating new template ---
                    const sNewId = "TPL_" + Date.now();
                    this._createEntry(oODataModel, "/Templates", {
                        ID: sNewId,
                        name: sName
                    });
                    await oODataModel.submitBatch(BATCH_GROUP);

                    // Create phases
                    aPhases.forEach((phase, pIdx) => {
                        this._createEntry(oODataModel, "/TemplatePhases", {
                            template_ID: sNewId,
                            name: phase.name,
                            sequence: pIdx + 1
                        });
                    });
                    await oODataModel.submitBatch(BATCH_GROUP);

                    // Load phases to get their IDs, then create tasks
                    const aNewPhaseCtxs = await this._loadTemplatePhasesForTemplate(oODataModel, sNewId);
                    const sortedNewPhases = aNewPhaseCtxs.map(c => c.getObject()).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

                    for (let pIdx = 0; pIdx < aPhases.length && pIdx < sortedNewPhases.length; pIdx++) {
                        const phase = aPhases[pIdx];
                        const backendPhase = sortedNewPhases[pIdx];
                        if (phase.tasks) {
                            phase.tasks.forEach((task, tIdx) => {
                                this._createEntry(oODataModel, "/TemplateTasks", {
                                    phase_ID: backendPhase.ID,
                                    name: task.name,
                                    role: task.role || '',
                                    defaultHours: parseInt(task.defaultHours) || 8,
                                    sequence: tIdx + 1
                                });
                            });
                        }
                    }

                    await oODataModel.submitBatch(BATCH_GROUP);
                    MessageToast.show("Template Saved successfully");
                }

                oModel.setProperty("/uiState/editingTemplatePath", null);
                oModel.setProperty("/uiState/showNewTemplate", false);
                await this._loadBackendData();
            } catch (e) {
                MessageToast.show("Failed to save template");
                console.error("Error saving template", e);
            }
        },

        onDeleteTemplate: async function () {
            const oModel = this.getView().getModel();
            const sEditPath = oModel.getProperty("/uiState/editingTemplatePath");
            if (!sEditPath) return;

            const oTemplate = oModel.getProperty(sEditPath);
            if (!oTemplate || !oTemplate.id) return;

            const oODataModel = this._getODataModel();
            const sTemplateId = oTemplate.id;

            try {
                // Delete all tasks and phases belonging to this template
                const aPhaseCtxs = await this._loadTemplatePhasesForTemplate(oODataModel, sTemplateId);
                for (const oPhaseCtx of aPhaseCtxs) {
                    const phaseObj = oPhaseCtx.getObject ? oPhaseCtx.getObject() : {};
                    const aTaskCtxs = await this._loadTemplateTasksForPhase(oODataModel, phaseObj.ID);
                    for (const oTaskCtx of aTaskCtxs) {
                        if (oTaskCtx.delete) oTaskCtx.delete(BATCH_GROUP);
                    }
                    if (oPhaseCtx.delete) oPhaseCtx.delete(BATCH_GROUP);
                }

                // Delete the template itself
                const oTplBinding = oODataModel.bindList("/Templates");
                const aTplCtxs = await oTplBinding.requestContexts(0, 500);
                const oTplCtx = aTplCtxs.find(c => {
                    const o = c.getObject ? c.getObject() : {};
                    return o.ID === sTemplateId;
                });
                if (oTplCtx && oTplCtx.delete) {
                    oTplCtx.delete(BATCH_GROUP);
                }

                await oODataModel.submitBatch(BATCH_GROUP);
                MessageToast.show("Template deleted");
                oModel.setProperty("/uiState/editingTemplatePath", null);
                oModel.setProperty("/uiState/showNewTemplate", false);
                await this._loadBackendData();
            } catch (e) {
                MessageToast.show("Failed to delete template");
                console.error("Error deleting template", e);
            }
        },

        _loadTemplatePhasesForTemplate: async function (oODataModel, sTemplateId) {
            const oListBinding = oODataModel.bindList("/TemplatePhases");
            const aContexts = await oListBinding.requestContexts(0, 500);
            return aContexts.filter(function (oCtx) {
                const o = oCtx.getObject ? oCtx.getObject() : {};
                return o.template_ID === sTemplateId;
            });
        },

        _loadTemplateTasksForPhase: async function (oODataModel, sPhaseId) {
            const oListBinding = oODataModel.bindList("/TemplateTasks");
            const aContexts = await oListBinding.requestContexts(0, 500);
            return aContexts.filter(function (oCtx) {
                const o = oCtx.getObject ? oCtx.getObject() : {};
                return o.phase_ID === sPhaseId;
            });
        },

        onAddTemplatePhase: function () {
            const oModel = this.getView().getModel();
            const aPhases = oModel.getProperty("/uiState/editingTemplatePhases") || [];
            aPhases.push({ id: "ph_" + Date.now(), name: "New Phase", tasks: [] });
            oModel.setProperty("/uiState/editingTemplatePhases", aPhases);
        },

        onRemovePhaseFromTemplate: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const path = oContext.getPath();
            const idx = parseInt(path.split("/").pop());
            const oModel = this.getView().getModel();
            const aPhases = oModel.getProperty("/uiState/editingTemplatePhases");
            aPhases.splice(idx, 1);
            oModel.setProperty("/uiState/editingTemplatePhases", aPhases);
        },

        onAddTaskToPhase: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const path = oContext.getPath();
            const oModel = this.getView().getModel();
            const oPhase = oModel.getProperty(path);
            oPhase.tasks = oPhase.tasks || [];
            oPhase.tasks.push({ id: "tk_" + Date.now(), name: "New Task", role: "", defaultHours: 8 });
            oModel.setProperty(path, oPhase);
        },

        onRemoveTaskFromPhase: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const taskPath = oContext.getPath();
            const parts = taskPath.split("/");
            const taskIdx = parseInt(parts.pop());
            parts.pop(); // remove 'tasks'
            const phasePath = parts.join("/");

            const oModel = this.getView().getModel();
            const oPhase = oModel.getProperty(phasePath);
            oPhase.tasks.splice(taskIdx, 1);
            oModel.setProperty(phasePath, oPhase);
        },

        parseCSV: function (text) {
            const lines = text.split('\n').filter(l => l.trim() !== '');
            if (lines.length < 2) return [];
            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            return lines.slice(1).map(line => {
                const values = line.split(',').map(v => v.trim());
                const obj = {};
                headers.forEach((h, i) => obj[h] = values[i] || '');
                return obj;
            });
        },

        handleTemplateImport: function (oEvent) {
            const file = oEvent.getParameter("files")[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (e) => {
                const text = e.target.result;
                const parsedData = this.parseCSV(text);

                if (parsedData.length === 0) {
                    MessageToast.show("CSV is empty or invalid format.");
                    return;
                }

                const phasesMap = new Map();
                parsedData.forEach((row) => {
                    const phaseName = row.phase || 'Imported Phase';
                    const taskName = row.task || row['task name'] || 'Imported Task';
                    const role = row.role || '';
                    const hoursStr = row.hours || row['default hours'] || row['hrs'];
                    const hours = parseInt(hoursStr) || 8;

                    if (!phasesMap.has(phaseName)) {
                        phasesMap.set(phaseName, []);
                    }
                    phasesMap.get(phaseName).push({
                        name: taskName,
                        role: role,
                        defaultHours: hours
                    });
                });

                const oODataModel = this._getODataModel();
                const sNewId = "TPL_" + Date.now();

                try {
                    // Create template
                    this._createEntry(oODataModel, "/Templates", {
                        ID: sNewId,
                        name: file.name.replace('.csv', '') || 'Imported Template'
                    });
                    await oODataModel.submitBatch(BATCH_GROUP);

                    // Create phases
                    const phaseEntries = Array.from(phasesMap.entries());
                    phaseEntries.forEach(([name], pIdx) => {
                        this._createEntry(oODataModel, "/TemplatePhases", {
                            template_ID: sNewId,
                            name: name,
                            sequence: pIdx + 1
                        });
                    });
                    await oODataModel.submitBatch(BATCH_GROUP);

                    // Load phases to get IDs, then create tasks
                    const aNewPhaseCtxs = await this._loadTemplatePhasesForTemplate(oODataModel, sNewId);
                    const sortedPhases = aNewPhaseCtxs.map(c => c.getObject()).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

                    for (let pIdx = 0; pIdx < phaseEntries.length && pIdx < sortedPhases.length; pIdx++) {
                        const tasks = phaseEntries[pIdx][1];
                        const backendPhase = sortedPhases[pIdx];
                        tasks.forEach((task, tIdx) => {
                            this._createEntry(oODataModel, "/TemplateTasks", {
                                phase_ID: backendPhase.ID,
                                name: task.name,
                                role: task.role || '',
                                defaultHours: task.defaultHours || 8,
                                sequence: tIdx + 1
                            });
                        });
                    }

                    await oODataModel.submitBatch(BATCH_GROUP);
                    MessageToast.show("Template imported successfully.");
                    await this._loadBackendData();
                } catch (err) {
                    MessageToast.show("Failed to import template.");
                    console.error("Error importing template", err);
                }
            };
            reader.readAsText(file);
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

                // Delete associated WBSTasks
                const wbsBinding = oODataModel.bindList("/WBSTasks");
                const wbsContexts = await wbsBinding.requestContexts(0, 1000);
                wbsContexts.forEach(c => {
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
                
                // Clear UI state if the deleted project was active in WBS or Timeline
                const oModel = this.getView().getModel();
                if (oModel.getProperty("/wbsSelectedProjectId") === sId) {
                    oModel.setProperty("/wbsSelectedProjectId", "");
                    oModel.setProperty("/wbsTasksForSelectedProject", []);
                }
                if (oModel.getProperty("/timelineSelectedProjectId") === sId) {
                    oModel.setProperty("/timelineSelectedProjectId", "");
                }

                // Immediately remove from local model so the table updates instantly
                const aProjects = oModel.getProperty("/projects") || [];
                const updatedProjects = aProjects.filter(p => p.id !== sId);
                oModel.setProperty("/projects", updatedProjects);
                this._calculateAnalytics(); // Refresh the enrichedProjects list for the table

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


        onSaveResource: async function () {
            const oModel = this.getView().getModel();
            const newRes = oModel.getProperty("/newResource");
            const editId = oModel.getProperty("/editingResourceId");

            if (!newRes.name || !newRes.roles || newRes.roles.length === 0) {
                MessageToast.show("Please fill required fields (Name, Roles)");
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

        onDeleteResource: function (oEvent) {
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

            const sName = oObj.name || "this resource";

            // Store details for the confirm handler
            this._pendingDeleteResourceId = sId;
            this.getView().getModel().setProperty("/pendingDeleteResourceName", sName);

            const oView = this.getView();
            if (!this._pDeleteResConfirmDialog) {
                this._pDeleteResConfirmDialog = this.loadFragment({
                    name: "projectmanagement.view.fragments.DeleteResourceConfirmation"
                }).then(function (oDialog) {
                    oView.addDependent(oDialog);
                    return oDialog;
                });
            }
            this._pDeleteResConfirmDialog.then(function (oDialog) {
                oDialog.open();
            });
        },

        onDeleteResourceConfirm: async function () {
            // Close the dialog first
            if (this._pDeleteResConfirmDialog) {
                this._pDeleteResConfirmDialog.then(function (oDialog) {
                    oDialog.close();
                });
            }

            const sId = this._pendingDeleteResourceId;
            if (!sId) return;
            this._pendingDeleteResourceId = null;

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

        onDeleteResourceCancel: function () {
            this._pendingDeleteResourceId = null;
            if (this._pDeleteResConfirmDialog) {
                this._pDeleteResConfirmDialog.then(function (oDialog) {
                    oDialog.close();
                });
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

        // --- WBS Logic ---
        onWbsProjectChange: function () {
            this._computeWbsTasks();
            this._computeTimelineData();
        },

        _computeWbsTasks: function () {
            const oModel = this.getView().getModel();
            const pid = oModel.getProperty("/wbsSelectedProjectId");
            const allTasks = oModel.getProperty("/wbsTasks") || [];

            const filteredTasks = allTasks.filter(t => t.projectId === pid).map((t, idx) => {
                t.index = idx + 1;
                t.startDateEdit = t.startDate ? t.startDate.slice(0, 10) : "";
                t.endDateEdit = t.endDate ? t.endDate.slice(0, 10) : "";
                return t;
            });
            oModel.setProperty("/wbsTasksForSelectedProject", filteredTasks);
        },

        calculateEndDate: function (startDateStr, hours) {
            if (!startDateStr || !hours || hours <= 0) return startDateStr;
            const sDate = new Date(startDateStr + 'T00:00:00');
            if (isNaN(sDate.getTime())) return startDateStr;

            const daysNeeded = Math.ceil(hours / 8);
            let currentDays = 0;
            const date = new Date(sDate.getTime());

            if (date.getDay() !== 0 && date.getDay() !== 6) {
                currentDays = 1;
            }

            while (currentDays < daysNeeded) {
                date.setDate(date.getDate() + 1);
                if (date.getDay() !== 0 && date.getDay() !== 6) {
                    currentDays++;
                }
            }

            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        },

        getNextWorkingDay: function (dateStr) {
            if (!dateStr) return '';
            const date = new Date(dateStr + 'T00:00:00');
            if (isNaN(date.getTime())) return '';

            date.setDate(date.getDate() + 1);
            while (date.getDay() === 0 || date.getDay() === 6) {
                date.setDate(date.getDate() + 1);
            }
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        },

        onAddWbsTask: async function () {
            const oModel = this.getView().getModel();
            const projId = oModel.getProperty("/wbsSelectedProjectId");
            if (!projId) return;

            const projects = oModel.getProperty("/projects") || [];
            const p = projects.find(x => x.id === projId);
            const defaultHours = 8;
            const endDate = p && p.startDate ? this.calculateEndDate(p.startDate, defaultHours) : (p ? p.endDate : '');

            const oODataModel = this._getODataModel();
            try {
                this._createEntry(oODataModel, "/WBSTasks", {
                    project_ID: projId,
                    phaseName: 'New Phase',
                    name: 'New Task',
                    role: '',
                    resource_ID: null,
                    hours: defaultHours,
                    startDate: this._formatDateForOData(p ? p.startDate : null),
                    endDate: this._formatDateForOData(endDate),
                    status: 'Not Started',
                    sequence: (oModel.getProperty("/wbsTasks") || []).filter(t => t.projectId === projId).length + 1,
                    predecessor_ID: null
                });
                await oODataModel.submitBatch(BATCH_GROUP);
                await this._loadBackendData();
                MessageToast.show("Task added");
            } catch (e) {
                MessageToast.show("Failed to add WBS task");
                console.error("Error adding WBS task", e);
            }
        },

        onRemoveWbsTask: async function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const taskId = oContext.getObject().id;

            const oODataModel = this._getODataModel();
            try {
                const oListBinding = oODataModel.bindList("/WBSTasks");
                const aContexts = await oListBinding.requestContexts(0, 1000);
                const oTaskCtx = aContexts.find(c => {
                    const o = c.getObject ? c.getObject() : {};
                    return o.ID === taskId;
                });
                if (oTaskCtx && oTaskCtx.delete) {
                    oTaskCtx.delete(BATCH_GROUP);
                }
                await oODataModel.submitBatch(BATCH_GROUP);
                await this._loadBackendData();
                MessageToast.show("Task removed");
            } catch (e) {
                MessageToast.show("Failed to remove WBS task");
                console.error("Error removing WBS task", e);
            }
        },

        onUpdateWbsTask: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const task = oContext.getObject();
            this._syncWbsTaskToMain(task);
        },

        onUpdateWbsTaskHours: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const task = oContext.getObject();
            task.hours = parseFloat(task.hours) || 0;
            task.endDate = this.calculateEndDate(task.startDate, task.hours);
            this._syncWbsTaskToMain(task);
            // Cascade to other tasks with the same resource
            if (task.resourceId) {
                this._recalculateResourceSchedule(task.projectId, task.resourceId);
            }
        },

        onUpdateWbsTaskStartDate: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const task = oContext.getObject();
            task.startDate = task.startDateEdit || "";
            task.endDate = this.calculateEndDate(task.startDate, task.hours);
            this._syncWbsTaskToMain(task);
            // Cascade to other tasks with the same resource
            if (task.resourceId) {
                this._recalculateResourceSchedule(task.projectId, task.resourceId);
            }
        },

        onUpdateWbsTaskEndDate: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const task = oContext.getObject();
            task.endDate = task.endDateEdit || "";
            task.hours = this.getWorkingHours(task.startDate, task.endDateEdit);
            this._syncWbsTaskToMain(task);
            // Cascade to other tasks with the same resource
            if (task.resourceId) {
                this._recalculateResourceSchedule(task.projectId, task.resourceId);
            }
        },

        onUpdateWbsTaskPredecessor: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const task = oContext.getObject();
            this._syncWbsTaskToMain(task);
        },

        onUpdateWbsTaskResource: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext();
            const task = oContext.getObject();
            const oModel = this.getView().getModel();
            const allTasks = oModel.getProperty("/wbsTasks") || [];

            if (task.resourceId) {
                // Find other tasks with the same resource in the same project
                const otherTasks = allTasks.filter(ot =>
                    ot.projectId === task.projectId &&
                    ot.resourceId === task.resourceId &&
                    ot.id !== task.id &&
                    ot.endDate
                );
                if (otherTasks.length > 0) {
                    const maxEndDate = otherTasks.reduce((max, ot) =>
                        ot.endDate > max ? ot.endDate : max, otherTasks[0].endDate);
                    if (maxEndDate) {
                        const nextStartDate = this.getNextWorkingDay(maxEndDate);
                        if (nextStartDate) {
                            task.startDate = nextStartDate;
                            task.startDateEdit = nextStartDate;
                            task.endDate = this.calculateEndDate(nextStartDate, task.hours);
                            task.endDateEdit = task.endDate;
                        }
                    }
                } else {
                    // Resource has no other tasks in this project; start at project start date
                    const projects = oModel.getProperty("/projects") || [];
                    const p = projects.find(x => x.id === task.projectId);
                    if (p && p.startDate) {
                        task.startDate = p.startDate;
                        task.startDateEdit = p.startDate;
                        task.endDate = this.calculateEndDate(p.startDate, task.hours);
                        task.endDateEdit = task.endDate;
                    }
                }
            }
            this._syncWbsTaskToMain(task);
            if (task.resourceId) {
                this._recalculateResourceSchedule(task.projectId, task.resourceId);
            }
        },

        /**
         * Recalculates dates for all tasks sharing the same resource in a project.
         * Tasks are sorted by start date and chained: each subsequent task starts
         * on the next working day after the previous task ends.
         */
        _recalculateResourceSchedule: function (projectId, resourceId) {
            if (!resourceId) return;
            const oModel = this.getView().getModel();
            const allTasks = oModel.getProperty("/wbsTasks") || [];

            // Get all tasks for this resource in this project
            const resourceTasks = allTasks.filter(t =>
                t.projectId === projectId && t.resourceId === resourceId
            );

            if (resourceTasks.length <= 1) return;

            // Sort by start date (earliest first)
            resourceTasks.sort((a, b) => {
                const aDate = a.startDate || "9999-12-31";
                const bDate = b.startDate || "9999-12-31";
                return aDate.localeCompare(bDate);
            });

            // Chain dates: each subsequent task starts after the previous one ends
            let changed = false;
            for (let i = 1; i < resourceTasks.length; i++) {
                const prevTask = resourceTasks[i - 1];
                const currTask = resourceTasks[i];

                if (prevTask.endDate) {
                    const nextStart = this.getNextWorkingDay(prevTask.endDate);
                    if (nextStart && currTask.startDate !== nextStart) {
                        currTask.startDate = nextStart;
                        currTask.startDateEdit = nextStart;
                        currTask.endDate = this.calculateEndDate(nextStart, currTask.hours || 0);
                        currTask.endDateEdit = currTask.endDate;

                        // Update in allTasks array
                        const idx = allTasks.findIndex(t => t.id === currTask.id);
                        if (idx > -1) {
                            allTasks[idx] = { ...currTask };
                        }
                        // Persist cascaded task to backend
                        this._syncWbsTaskToMain(currTask);
                        changed = true;
                    }
                }
            }

            if (changed) {
                oModel.setProperty("/wbsTasks", allTasks);
                this._computeWbsTasks();
                this._computeTimelineData();
            }
        },

        _syncWbsTaskToMain: async function (taskData) {
            const oModel = this.getView().getModel();
            const allTasks = oModel.getProperty("/wbsTasks") || [];
            const idx = allTasks.findIndex(t => t.id === taskData.id);
            if (idx > -1) {
                allTasks[idx] = { ...taskData };
                oModel.setProperty("/wbsTasks", allTasks);
                this._computeWbsTasks();
                this._computeTimelineData();
            }

            // Persist to backend
            const oODataModel = this._getODataModel();
            try {
                const oCtx = oODataModel.bindContext("/WBSTasks(" + taskData.id + ")").getBoundContext();
                oCtx.setProperty("phaseName", taskData.phaseName || '');
                oCtx.setProperty("name", taskData.name || '');
                oCtx.setProperty("role", taskData.role || '');
                oCtx.setProperty("resource_ID", taskData.resourceId || null);
                oCtx.setProperty("hours", parseInt(taskData.hours) || 0);
                oCtx.setProperty("startDate", this._formatDateForOData(taskData.startDate));
                oCtx.setProperty("endDate", this._formatDateForOData(taskData.endDate));
                oCtx.setProperty("predecessor_ID", taskData.predecessor || null);
                await oODataModel.submitBatch(BATCH_GROUP);
            } catch (e) {
                console.error("Error syncing WBS task to backend", e);
            }
        },

        onImportTemplateToWBS: async function () {
            const oModel = this.getView().getModel();
            const tplId = oModel.getProperty("/wbsImportTemplateId");
            const projId = oModel.getProperty("/wbsSelectedProjectId");

            const tpl = (oModel.getProperty("/templates") || []).find(t => t.id === tplId);
            const proj = (oModel.getProperty("/projects") || []).find(p => p.id === projId);

            if (!tpl || !proj) return;

            const oODataModel = this._getODataModel();
            const existingTasks = (oModel.getProperty("/wbsTasks") || []).filter(t => t.projectId === projId);
            let seq = existingTasks.length;

            try {
                if (tpl.phases) {
                    tpl.phases.forEach(phase => {
                        if (phase.tasks) {
                            phase.tasks.forEach(task => {
                                seq++;
                                this._createEntry(oODataModel, "/WBSTasks", {
                                    project_ID: proj.id,
                                    phaseName: phase.name,
                                    name: task.name,
                                    role: task.role || '',
                                    resource_ID: null,
                                    hours: task.defaultHours || 8,
                                    startDate: this._formatDateForOData(proj.startDate),
                                    endDate: this._formatDateForOData(this.calculateEndDate(proj.startDate, task.defaultHours || 8)),
                                    status: 'Not Started',
                                    sequence: seq,
                                    predecessor_ID: null
                                });
                            });
                        }
                    });
                }

                await oODataModel.submitBatch(BATCH_GROUP);
                oModel.setProperty("/wbsImportTemplateId", "");
                MessageToast.show("Template imported into WBS");
                await this._loadBackendData();
            } catch (e) {
                MessageToast.show("Failed to import template to WBS");
                console.error("Error importing template to WBS", e);
            }
        },

        handleWbsImport: function (oEvent) {
            const file = oEvent.getParameter("files")[0];
            if (!file) return;

            const oModel = this.getView().getModel();
            const projId = oModel.getProperty("/wbsSelectedProjectId");
            if (!projId) {
                MessageToast.show("Please select a project first.");
                return;
            }

            const proj = (oModel.getProperty("/projects") || []).find(p => p.id === projId);

            const reader = new FileReader();
            reader.onload = async (e) => {
                const text = e.target.result;
                const parsedData = this.parseCSV(text);

                if (parsedData.length === 0) {
                    MessageToast.show("CSV is empty or invalid format.");
                    return;
                }

                const oODataModel = this._getODataModel();
                const existingTasks = (oModel.getProperty("/wbsTasks") || []).filter(t => t.projectId === projId);
                let seq = existingTasks.length;

                try {
                    parsedData.forEach((row) => {
                        const phase = row.phase || 'Imported Phase';
                        const taskName = row.task || row['task name'] || 'Imported Task';
                        const hoursStr = row.hours || row['default hours'] || row['hrs'];
                        const hours = parseInt(hoursStr) || 8;
                        const role = row.role || '';

                        let startDate = row['start date'] || row.startdate || row.start;
                        if (!startDate || isNaN(new Date(startDate + 'T00:00:00').getTime())) {
                            startDate = proj ? proj.startDate : '';
                        }

                        seq++;
                        this._createEntry(oODataModel, "/WBSTasks", {
                            project_ID: projId,
                            phaseName: phase,
                            name: taskName,
                            role: role,
                            resource_ID: null,
                            hours: hours,
                            startDate: this._formatDateForOData(startDate),
                            endDate: this._formatDateForOData(this.calculateEndDate(startDate, hours)),
                            status: 'Not Started',
                            sequence: seq,
                            predecessor_ID: null
                        });
                    });

                    await oODataModel.submitBatch(BATCH_GROUP);
                    MessageToast.show("Successfully imported tasks from CSV.");
                    await this._loadBackendData();
                } catch (err) {
                    MessageToast.show("Failed to import WBS tasks from CSV.");
                    console.error("Error importing WBS from CSV", err);
                }
            };
            reader.readAsText(file);
        },

        // --- Timeline Logic ---
        onTimelineProjectChange: function () {
            this._computeTimelineData();
        },

        onSetTimelineTasks: function () {
            this.getView().getModel().setProperty("/timelineActiveSection", "tasks");
        },

        onSetTimelineResources: function () {
            this.getView().getModel().setProperty("/timelineActiveSection", "resources");
        },

        _computeTimelineData: function () {
            const oModel = this.getView().getModel();
            const pId = oModel.getProperty("/timelineSelectedProjectId");
            if (!pId) {
                oModel.setProperty("/timelineData", null);
                oModel.setProperty("/timelineResourceData", []);
                return;
            }

            const projects = oModel.getProperty("/projects") || [];
            const proj = projects.find(p => p.id === pId);
            if (!proj) return;

            const allWbsTasks = oModel.getProperty("/wbsTasks") || [];
            const tasks = allWbsTasks.filter(t => t.projectId === pId && t.startDate && t.endDate);

            if (tasks.length === 0) {
                oModel.setProperty("/timelineData", { proj: proj, tasks: [], weeks: [] });
                oModel.setProperty("/timelineResourceData", []);
                return;
            }

            const minTime = Math.min(...tasks.map(t => new Date(t.startDate + 'T00:00:00').getTime()));
            const maxTime = Math.max(...tasks.map(t => new Date(t.endDate + 'T00:00:00').getTime()));

            const pStart = new Date(proj.startDate + 'T00:00:00').getTime();
            const pEnd = new Date(proj.endDate + 'T00:00:00').getTime();

            const startTimestamp = Math.min(minTime, pStart);
            const endTimestamp = Math.max(maxTime, pEnd);

            // Calculate total days inclusive (e.g., Mar 4 to Mar 5 is 2 days)
            const msPerDay = 1000 * 3600 * 24;
            const totalDurationDays = Math.max(1, Math.round((endTimestamp - startTimestamp) / msPerDay) + 1);

            const resources = oModel.getProperty("/resources") || [];

            // Build the full list of day timestamps for proper bar alignment
            var timelineDayTimestamps = [];
            {
                var d = new Date(startTimestamp);
                d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
                var dEnd = new Date(endTimestamp);
                dEnd = new Date(Date.UTC(dEnd.getFullYear(), dEnd.getMonth(), dEnd.getDate()));
                while (d <= dEnd) {
                    timelineDayTimestamps.push(d.getTime());
                    d.setUTCDate(d.getUTCDate() + 1);
                }
            }
            var totalCells = timelineDayTimestamps.length;

            var enrichedTasks = tasks.map(function (t) {
                var tStart = new Date(t.startDate + 'T00:00:00');
                tStart = new Date(Date.UTC(tStart.getFullYear(), tStart.getMonth(), tStart.getDate())).getTime();
                var tEnd = new Date(t.endDate + 'T00:00:00');
                tEnd = new Date(Date.UTC(tEnd.getFullYear(), tEnd.getMonth(), tEnd.getDate())).getTime();

                // Find the index of the start day and end day in the timeline cells
                var startIdx = 0;
                var endIdx = totalCells - 1;
                for (var i = 0; i < totalCells; i++) {
                    if (timelineDayTimestamps[i] >= tStart) { startIdx = i; break; }
                }
                for (var j = totalCells - 1; j >= 0; j--) {
                    if (timelineDayTimestamps[j] <= tEnd) { endIdx = j; break; }
                }

                // Calculate percentage based on cell indices (each cell is 1/totalCells wide)
                var left = (startIdx / totalCells) * 100;
                var width = ((endIdx - startIdx + 1) / totalCells) * 100;

                var res = resources.find(function (r) { return r.id === t.resourceId; });
                return Object.assign({}, t, {
                    leftPct: Math.min(100, Math.max(0, left)),
                    widthPct: Math.min(100 - left, Math.max(0.5, width)),
                    resourceName: res ? res.name : 'Unassigned'
                });
            });

            const weeks = [];
            const dayLetters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
            // Use UTC to avoid DST shifts creating duplicate/missing days
            let currentDay = new Date(startTimestamp);
            currentDay = new Date(Date.UTC(currentDay.getFullYear(), currentDay.getMonth(), currentDay.getDate()));

            let endDay = new Date(endTimestamp);
            endDay = new Date(Date.UTC(endDay.getFullYear(), endDay.getMonth(), endDay.getDate()));

            let weekIndex = 1;

            if (totalDurationDays > 0) {
                while (currentDay <= endDay) {
                    const days = [];

                    while (currentDay <= endDay) {
                        const dateObj = new Date(currentDay);
                        const dayOfWeek = dateObj.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
                        const dateNum = dateObj.getUTCDate();

                        days.push({
                            label: dayLetters[dayOfWeek] + dateNum,
                            fullDate: `${dateObj.getUTCMonth() + 1}/${dateNum}/${dateObj.getUTCFullYear()}`,
                            isWeekend: dayOfWeek === 0 || dayOfWeek === 6
                        });

                        // Increment by exactly 24 hours in UTC
                        currentDay.setUTCDate(currentDay.getUTCDate() + 1);

                        // Week ends on Sunday (dayOfWeek === 0) — Mon-to-Sun weeks
                        if (dayOfWeek === 0) {
                            break;
                        }
                    }

                    if (days.length > 0) {
                        weeks.push({
                            label: `Week ${weekIndex}`,
                            days: days,
                            daysCount: days.length
                        });
                        weekIndex++;
                    }
                }
            } else {
                weeks.push({ label: "Week 1", days: [], daysCount: 1 });
            }
            var gridMinWidth = totalCells * 28;
            oModel.setProperty("/timelineData", { proj: proj, tasks: enrichedTasks, weeks: weeks, totalDayCells: totalCells, gridMinWidth: gridMinWidth + 'px' });

            // Compute Resource timeline data
            const map = new Map();
            enrichedTasks.forEach(task => {
                const rId = task.resourceId || 'unassigned';
                if (!map.has(rId)) {
                    map.set(rId, {
                        resourceId: rId,
                        resourceName: task.resourceName,
                        totalHours: 0,
                        tasks: []
                    });
                }
                const group = map.get(rId);
                group.totalHours += task.hours;

                // Position sequentially
                const topPx = (group.tasks.length * 32) + 8;
                group.tasks.push({ ...task, topPx: topPx });
            });

            const rData = Array.from(map.values()).map(r => {
                r.heightPx = (r.tasks.length * 32) + 16;
                return r;
            });

            oModel.setProperty("/timelineResourceData", rData);

            // Set min-width on grid areas after SAPUI5 renders
            setTimeout(function () {
                var gridAreas = document.querySelectorAll('.timelineGridArea');
                gridAreas.forEach(function (area) {
                    area.style.minWidth = gridMinWidth + 'px';
                });
            }, 200);
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
        },
        formatDecimal: function (value) {
            if (value === null || value === undefined) return "0.00";
            return parseFloat(value).toFixed(2);
        }
    });
});