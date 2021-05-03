import {Component, Event, EventEmitter, h, Host, Method, Prop, State, Watch} from '@stencil/core';
import {v4 as uuid} from 'uuid';
import {addConnection, findActivity, getChildActivities, getInboundConnections, getOutboundConnections, Map, removeActivity, removeConnection} from '../../../../utils/utils';
import {ActivityDescriptor, ActivityDesignDisplayContext, ActivityModel, ActivityTraits, ConnectionModel, EventTypes, WorkflowModel, WorkflowPersistenceBehavior,} from '../../../../models';
import {eventBus} from '../../../../services/event-bus';
import * as d3 from 'd3';
import dagreD3 from 'dagre-d3';
import {registerClickOutside} from 'stencil-click-outside';
import state from '../../../../utils/store';
import {ActivityIcon} from '../../../icons/activity-icon';
import {ActivityContextMenuState, WorkflowDesignerMode} from "./models";

@Component({
  tag: 'elsa-designer-tree',
  styleUrls: ['elsa-designer-tree.css'],
  assetsDirs: ['assets'],
  shadow: false,
})
export class ElsaWorkflowDesigner {
  @Prop() model: WorkflowModel = {activities: [], connections: [], persistenceBehavior: WorkflowPersistenceBehavior.WorkflowBurst};
  @Prop() selectedActivityIds: Array<string> = [];
  @Prop() activityContextMenuButton?: string;
  @Prop() activityContextMenu?: ActivityContextMenuState;
  @Prop() mode: WorkflowDesignerMode = WorkflowDesignerMode.Edit;
  @Event({eventName: 'workflow-changed', bubbles: true, composed: true, cancelable: true}) workflowChanged: EventEmitter<WorkflowModel>;
  @Event() activitySelected: EventEmitter<ActivityModel>;
  @Event() activityDeselected: EventEmitter<ActivityModel>;
  @Event() activityContextMenuButtonClicked: EventEmitter<ActivityContextMenuState>;
  @State() workflowModel: WorkflowModel;

  @State() activityContextMenuState: ActivityContextMenuState = {
    shown: false,
    x: 0,
    y: 0,
    activity: null,
  };

  el: HTMLElement;
  svg: SVGElement;
  inner: SVGElement;
  svgD3Selected: d3.Selection<SVGElement, unknown, null, undefined>;
  innerD3Selected: d3.Selection<SVGElement, unknown, null, undefined>;
  zoomParams: { x: number; y: number; scale: number } = {x: 0, y: 0, scale: 1};
  dagreD3Renderer: dagreD3.Render = new dagreD3.render();

  graph: dagreD3.graphlib.Graph = new dagreD3.graphlib.Graph().setGraph({});
  zoom: d3.ZoomBehavior<Element, unknown>;
  parentActivityId?: string;
  parentActivityOutcome?: string;
  activityDisplayContexts: Map<ActivityDesignDisplayContext> = {};
  selectedActivities: Map<ActivityModel> = {};

  handleContextMenuChange(state: ActivityContextMenuState) {
    this.activityContextMenuState = state;
    this.activityContextMenuButtonClicked.emit(state);
  }

  @Watch('model')
  handleModelChanged(newValue: WorkflowModel) {
    this.updateWorkflowModel(newValue, false);
  }

  @Watch('selectedActivityIds')
  handleSelectedActivityIdsChanged(newValue: Array<string>) {
    const ids = newValue || [];
    const selectedActivities = this.workflowModel.activities.filter(x => ids.includes(x.activityId));
    const map: Map<ActivityModel> = {};

    for (const activity of selectedActivities)
      map[activity.activityId] = activity;

    this.selectedActivities = map;
    this.rerenderTree();
  }

  @Watch('activityContextMenu')
  handleActivityContextMenuChanged(newValue: ActivityContextMenuState) {
    this.activityContextMenuState = newValue;
  }

  @Method()
  async removeActivity(activity: ActivityModel) {
    this.removeActivityInternal(activity);
  }

  @Method()
  async showActivityEditor(activity: ActivityModel, animate: boolean) {
    this.showActivityEditorInternal(activity, animate);
  }

  showActivityEditorInternal(activity: ActivityModel, animate: boolean) {
    eventBus.emit(EventTypes.ShowActivityEditor, this, activity, animate);
  }

  handleEditActivity(activity: ActivityModel) {
    this.showActivityEditorInternal(activity, true);
  }

  updateWorkflowModel(model: WorkflowModel, emitEvent: boolean = true) {
    this.workflowModel = model;
    
    if(emitEvent)
      this.workflowChanged.emit(model);
    
    setTimeout(() => {
      this.rerenderTree();
    }, 50);
  }

  removeActivityInternal(activity: ActivityModel) {
    let workflowModel = {...this.workflowModel};
    const incomingConnections = getInboundConnections(workflowModel, activity.activityId);
    const outgoingConnections = getOutboundConnections(workflowModel, activity.activityId);

    // Remove activity (will also remove its connections).
    workflowModel = removeActivity(workflowModel, activity.activityId);

    // For each incoming activity, try to connect it to a outgoing activity based on outcome.
    for (const incomingConnection of incomingConnections) {
      const incomingActivity = findActivity(workflowModel, incomingConnection.sourceId);
      const outgoingConnection = outgoingConnections.find(x => x.outcome === incomingConnection.outcome);

      if (outgoingConnection) workflowModel = addConnection(workflowModel, incomingActivity.activityId, outgoingConnection.targetId, incomingConnection.outcome);
    }
    this.updateWorkflowModel(workflowModel);
  }

  connectedCallback() {
    eventBus.on(EventTypes.ActivityPicked, this.onActivityPicked);
    eventBus.on(EventTypes.UpdateActivity, this.onUpdateActivity);
  }

  disconnectedCallback() {
    eventBus.off(EventTypes.ActivityPicked, this.onActivityPicked);
    eventBus.off(EventTypes.UpdateActivity, this.onUpdateActivity);
    d3.selectAll('.node').on('click', null);
    d3.selectAll('.edgePath').on('contextmenu', null);

  }

  onActivityPicked = async args => {
    const activityDescriptor = args as ActivityDescriptor;
    const connectFromRoot = !this.parentActivityOutcome || this.parentActivityOutcome == '';
    const sourceId = connectFromRoot ? null : this.parentActivityId;
    const targetId = connectFromRoot ? this.parentActivityId : null;
    const activityModel = this.addActivity(activityDescriptor, sourceId, targetId, this.parentActivityOutcome);
    this.showActivityEditorInternal(activityModel, false);
  };

  onUpdateActivity = args => {
    const activityModel = args as ActivityModel;
    this.updateActivity(activityModel);
  };

  addActivity(activityDescriptor: ActivityDescriptor, sourceActivityId?: string, targetActivityId?: string, outcome?: string): ActivityModel {
    outcome = outcome || 'Done';

    const activity: ActivityModel = {
      activityId: uuid(),
      type: activityDescriptor.type,
      outcomes: activityDescriptor.outcomes,
      displayName: activityDescriptor.displayName,
      properties: [],
    };

    for (const property of activityDescriptor.properties) {
      activity.properties[property.name] = {
        syntax: '',
        expression: '',
      };
    }

    const workflowModel = {...this.workflowModel, activities: [...this.workflowModel.activities, activity]};

    if (targetActivityId) {
      const existingConnection = workflowModel.connections.find(x => x.targetId == targetActivityId && x.outcome == outcome);

      if (existingConnection) {
        workflowModel.connections = workflowModel.connections.filter(x => x != existingConnection);

        const replacementConnection = {
          ...existingConnection,
          sourceId: activity.activityId,
        };

        workflowModel.connections.push(replacementConnection);
      } else {
        workflowModel.connections.push({sourceId: activity.activityId, targetId: targetActivityId, outcome: outcome});
      }
    }

    if (sourceActivityId != null) {
      const existingConnection = workflowModel.connections.find(x => x.sourceId == sourceActivityId && x.outcome == outcome);

      if (existingConnection != null) {
        workflowModel.connections = workflowModel.connections.filter(x => x != existingConnection);

        const replacementConnection = {
          ...existingConnection,
          targetId: activity.activityId,
        };

        workflowModel.connections.push(replacementConnection);
        const connection: ConnectionModel = {sourceId: activity.activityId, targetId: existingConnection.targetId, outcome};
        workflowModel.connections.push(connection);
      } else {
        const connection: ConnectionModel = {sourceId: sourceActivityId, targetId: activity.activityId, outcome: outcome};
        workflowModel.connections.push(connection);
      }
    }

    this.updateWorkflowModel(workflowModel);
    this.parentActivityId = null;
    this.parentActivityOutcome = null;
    return activity;
  }

  getRootActivities(): Array<ActivityModel> {
    return getChildActivities(this.workflowModel, null);
  }

  addConnection(sourceActivityId: string, targetActivityId: string, outcome: string) {
    const workflowModel = {...this.workflowModel};
    const connection: ConnectionModel = {sourceId: sourceActivityId, targetId: targetActivityId, outcome: outcome};
    workflowModel.connections.push(connection);
    this.updateWorkflowModel(workflowModel);
    this.parentActivityId = null;
    this.parentActivityOutcome = null;
  }

  updateActivity(activity: ActivityModel) {
    let workflowModel = {...this.workflowModel};
    const activities = [...workflowModel.activities];
    const index = activities.findIndex(x => x.activityId === activity.activityId);
    activities[index] = activity;
    this.updateWorkflowModel({...workflowModel, activities: activities});
  }

  componentWillLoad() {
    this.workflowModel = this.model;
  }

  componentDidLoad() {
    this.svgD3Selected = d3.select(this.svg);
    this.innerD3Selected = d3.select(this.inner);
    setTimeout(() => {
      this.rerenderTree();
    }, 400);
  }

  componentWillRender() {
    const activityModels = this.workflowModel.activities;
    const displayContexts: Map<ActivityDesignDisplayContext> = {};
    const activityDescriptors: Array<ActivityDescriptor> = state.activityDescriptors;

    for (const model of activityModels) {
      const descriptor = activityDescriptors.find(x => x.type == model.type);
      const description = model.description;
      const bodyText = description && description.length > 0 ? description : undefined;
      const bodyDisplay = bodyText ? <p>{bodyText}</p> : undefined;
      const color = (descriptor.traits &= ActivityTraits.Trigger) == ActivityTraits.Trigger ? 'rose' : 'light-blue';

      const displayContext: ActivityDesignDisplayContext = {
        activityModel: model,
        activityIcon: <ActivityIcon color={color}/>,
        bodyDisplay: bodyDisplay,
        outcomes: [...model.outcomes],
      };

      eventBus.emit(EventTypes.ActivityDesignDisplaying, this, displayContext);
      displayContexts[model.activityId] = displayContext;
    }

    this.activityDisplayContexts = displayContexts;
  }

  componentDidRender() {
  }

  showActivityPicker() {
    eventBus.emit(EventTypes.ShowActivityPicker);
  }

  removeConnection(sourceId: string, outcome: string) {
    let workflowModel = {...this.workflowModel};
    workflowModel = removeConnection(workflowModel, sourceId, outcome);
    this.updateWorkflowModel(workflowModel);
  }

  applyZoom() {
    this.zoom = d3.zoom().on('zoom', event => {
      const {transform} = event;
      this.innerD3Selected.attr('transform', transform);
      this.zoomParams = {
        x: transform.x,
        y: transform.y,
        scale: transform.k,
      };
    });
    this.svgD3Selected.call(this.zoom);
  }

  setEntities() {
    this.graph = new dagreD3.graphlib.Graph().setGraph({});

    const rootActivities = this.getRootActivities();

    // Start node.
    this.graph.setNode('start', {
      shape: 'rect',
      label: this.mode == WorkflowDesignerMode.Edit
        ? `<button class="px-6 py-3 border border-transparent text-base leading-6 font-medium rounded-md text-white bg-green-600 hover:bg-green-500 focus:outline-none focus:border-green-700 focus:shadow-outline-green active:bg-green-700 transition ease-in-out duration-150">Start</button>`
        : `<button class="px-6 py-3 border border-transparent text-base leading-6 font-medium rounded-md text-white bg-green-600 focus:outline-none cursor-default">Start</button>`,
      rx: 5,
      ry: 5,
      labelType: 'html',
      class: 'start',
    });

    // Connections between Start and root activities.
    rootActivities.forEach(activity => {
      this.graph.setEdge('start', `${activity.activityId}/start`, {
        arrowhead: 'undirected',
      });
      this.graph.setNode(`${activity.activityId}/start`, {shape: 'rect', activity, label: this.renderOutcomeButton(), labelType: 'html', class: 'add'});
      this.graph.setEdge(`${activity.activityId}/start`, activity.activityId, {arrowhead: 'undirected'});
    });

    // Connections between activities and their outcomes.
    this.workflowModel.activities.forEach(activity => {
      this.graph.setNode(activity.activityId, this.createActivityOptions(activity));
      const displayContext = this.activityDisplayContexts[activity.activityId] || undefined;
      const outcomes = !!displayContext ? displayContext.outcomes : activity.outcomes || [];

      outcomes.forEach(outcome => {
        this.graph.setNode(`${activity.activityId}/${outcome}`, {shape: 'rect', outcome, activity, label: this.renderOutcomeButton(), labelType: 'html', class: 'add'});
        this.graph.setEdge(activity.activityId, `${activity.activityId}/${outcome}`, {
          label: `<p class="outcome mb-4 relative z-10 px-2.5 py-0.5 rounded-full text-xs font-medium leading-4 bg-cool-gray-100 text-cool-gray-800 capitalize cursor-default">${outcome}</p>`,
          labelpos: 'c',
          labelType: 'html',
          arrowhead: 'undirected',
        });
      });
    });

    this.workflowModel.connections.forEach(({sourceId, targetId, outcome}) => {
      const sourceName = `${sourceId}/${outcome}`;

      if (!this.graph.hasNode(sourceName)) {
        console.warn(`No source node with ID '${sourceName}' exists.`);
        return;
      }

      this.graph.setEdge(sourceName, targetId, {arrowhead: 'undirected'});
    });
  }

  renderNodes() {
    const prevTransform = this.innerD3Selected.attr('transform');
    const scaleAfter = this.zoomParams.scale;
    this.svgD3Selected.call(this.zoom.scaleTo, 1);
    this.dagreD3Renderer(this.innerD3Selected as any, this.graph as any);
    this.svgD3Selected.call(this.zoom.scaleTo, scaleAfter);
    this.innerD3Selected.attr('transform', prevTransform);

    if (this.mode == WorkflowDesignerMode.Edit) {
      d3.selectAll('.node.add').each((n: any) => {
        const node = this.graph.node(n) as any;

        d3.select(node.elem)
        .on('click', e => {
          e.preventDefault();
          d3.selectAll('.node.add svg').classed('text-green-400', false).classed('text-gray-400', true).classed('hover:text-blue-500', true);
          this.parentActivityId = node.activity.activityId;
          this.parentActivityOutcome = node.outcome;

          if (e.shiftKey) {
            d3.select(node.elem).select('svg').classed('text-green-400', true).classed('text-gray-400', false).classed('hover:text-blue-500', false);
            return;
          }

          this.showActivityPicker();
        })
        .on("mouseover", e => {
          if (e.shiftKey)
            d3.select(node.elem).select('svg').classed('text-green-400', true).classed('hover:text-blue-500', false);
        })
        .on("mouseout", e => {
          d3.select(node.elem).select('svg').classed('text-green-400', false).classed('hover:text-blue-500', true);
        });
      });

      d3.selectAll('.node.start').each((n: any) => {
        const node = this.graph.node(n) as any;
        d3.select(node.elem).on('click', e => {
          this.showActivityPicker();
        });
      });

      d3.selectAll('.edgePath').append(appendClickableEl).attr('class', 'label-clickable');

      function appendClickableEl() {
        const originalD = this.querySelector('.path').getAttribute('d');
        const newPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        newPath.setAttribute('d', originalD);
        return this.appendChild(newPath);
      }

      d3.selectAll('.edgePath').each((edg: any) => {
        const edge = this.graph.edge(edg) as any;
        d3.select(edge.elem).on('contextmenu', e => {
          e.preventDefault();
          const from = edg.v.split('/');
          const to = edg.w.split('/');
          const fromActivityId = from[0];
          const outcome = from[1] || to[1];
          this.removeConnection(fromActivityId, outcome);
        });
      });
    }

    d3.selectAll('.node.activity').each((n: any) => {
      const node = this.graph.node(n) as any;
      const activity = node.activity;
      const activityId = activity.activityId;

      d3.select(node.elem).on('click', () => {
        // If a parent activity was selected to connect to:
        if (this.mode == WorkflowDesignerMode.Edit && this.parentActivityId && this.parentActivityOutcome) {
          this.addConnection(this.parentActivityId, activityId, this.parentActivityOutcome);
        } else {
          // When clicking an activity:
          if (!!this.selectedActivities[activityId])
            delete this.selectedActivities[activityId];
          else {
            for (const key in this.selectedActivities) {
              this.activityDeselected.emit(this.selectedActivities[key]);
            }
            this.selectedActivities = {};
            this.selectedActivities[activityId] = activity;
            this.activitySelected.emit(activity);
          }

          this.rerenderTree();
        }
      });

      if (this.mode == WorkflowDesignerMode.Edit || this.mode == WorkflowDesignerMode.Instance) {
        d3.select(node.elem)
        .select('.context-menu-button-container button')
        .on('click', evt => {
          evt.stopPropagation();
          this.handleContextMenuChange({x: evt.clientX, y: evt.clientY, shown: true, activity: node.activity});
        });
      }
    });
  }

  rerenderTree() {
    this.applyZoom();
    this.setEntities();
    this.renderNodes();
  }

  createActivityOptions(activity: ActivityModel) {
    return {
      shape: 'rect',
      label: this.renderActivity(activity),
      rx: 5,
      ry: 5,
      labelType: 'html',
      class: 'activity',
      activity,
    };
  }

  createOutcomeActivityOptions() {
    return {shape: 'circle', label: this.renderOutcomeButton(), labelType: 'html', class: 'add', width: 32, height: 32};
  }

  renderOutcomeButton() {
    const cssClass = this.mode == WorkflowDesignerMode.Edit ? 'hover:text-blue-500 cursor-pointer' : 'cursor-default';
    return `<svg class="h-8 w-8 text-gray-400 ${cssClass}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>`;
  }

  renderActivity(activity: ActivityModel) {
    const displayContext = this.activityDisplayContexts[activity.activityId] || undefined;
    const cssClass = !!this.selectedActivities[activity.activityId] ? 'border-blue-600' : 'border-gray-200 hover:border-blue-600'

    return `<div id=${`activity-${activity.activityId}`} 
    class="activity border-2 border-solid rounded bg-white text-left text-black text-lg select-none max-w-md shadow-sm relative ${cssClass}">
      <div class="p-5">
        <div class="flex justify-between space-x-8">
          <div class="flex-shrink-0">
          ${displayContext?.activityIcon || ''}
          </div>
          <div class="flex-1 font-medium leading-8">
            <p>${activity.displayName}</p>
          </div>
          <div class="context-menu-button-container">
            ${!!this.activityContextMenuButton ? this.activityContextMenuButton : ''}
          </div>
        </div>
      </div>
      ${this.renderActivityBody(displayContext)}
      </div>`;
  }

  renderActivityBody(displayContext: ActivityDesignDisplayContext) {
    return (
      `<div class="p-6 text-gray-400 text-sm border-t border-t-solid">
        <div>${displayContext.activityModel.activityId}</div>
        <div>${displayContext.bodyDisplay}</div>
      </div>`
    );
  }

  render() {
    return (
      <Host class="workflow-canvas flex-1 flex" ref={el => (this.el = el)}>
        <svg ref={el => (this.svg = el)} id="svg" style={{height: 'calc(100vh - 64px)', width: '100%', pointerEvents: this.activityContextMenuState.shown ? 'none' : ''}}>
          <g ref={el => (this.inner = el)}/>
        </svg>
      </Host>
    );
  }
}
