import Layout from '../../layout';
import LayoutWorker from '../../layout/worker/layout.worker';
import { LAYOUT_MESSAGE } from '../../layout/worker/layoutConst';
import { isNaN } from '../../util/base';

import { IGraph } from '../../interface/graph';
import { path2Absolute } from '@antv/path-util';

const helper = {
  // pollyfill
  requestAnimationFrame(callback: FrameRequestCallback) {
    const fn =
      window.requestAnimationFrame ||
      window.webkitRequestAnimationFrame ||
      function (cb: TimerHandler) {
        return setTimeout(cb, 16);
      };
    return fn(callback);
  },
  cancelAnimationFrame(requestId: number) {
    const fn =
      window.cancelAnimationFrame ||
      window.webkitCancelAnimationFrame ||
      function (reqId: number) {
        return clearTimeout(reqId);
      };
    return fn(requestId);
  },
};

export default class LayoutController {
  public graph: IGraph;

  public destroyed: boolean;

  private layoutCfg;

  private layoutType: string;

  private layoutMethod;

  private worker;

  private workerData;

  private data;

  constructor(graph: IGraph) {
    this.graph = graph;
    this.layoutCfg = graph.get('layout') || {};
    this.layoutType = this.layoutCfg.type;
    this.worker = null;
    this.workerData = {};
    this.initLayout();
  }

  // eslint-disable-next-line class-methods-use-this
  private initLayout() {
    // no data before rendering
  }

  // get layout worker and create one if not exists
  private getWorker() {
    if (this.worker) {
      return this.worker;
    }

    if (typeof Worker === 'undefined') {
      // 如果当前浏览器不支持 web worker，则不使用 web worker
      console.warn('Web worker is not supported in current browser.');
      this.worker = null;
    } else {
      this.worker = new LayoutWorker();
    }
    return this.worker;
  }

  // stop layout worker
  private stopWorker() {
    const { workerData } = this;

    if (!this.worker) {
      return;
    }

    this.worker.terminate();
    this.worker = null;
    // 重新开始新的布局之前，先取消之前布局的requestAnimationFrame。
    if (workerData.requestId) {
      helper.cancelAnimationFrame(workerData.requestId);
      workerData.requestId = null;
    }
    if (workerData.requestId2) {
      helper.cancelAnimationFrame(workerData.requestId2);
      workerData.requestId2 = null;
    }
  }

  public getLayoutType(): string {
    return this.layoutCfg.type;
  }

  /**
   * @param {function} success callback
   * @return {boolean} 是否使用web worker布局
   */
  public layout(success?: () => void): boolean {
    const { graph } = this;

    this.data = this.setDataFromGraph();
    const { nodes } = this.data;

    if (!nodes) {
      return false;
    }
    const width = graph.get('width');
    const height = graph.get('height');
    const layoutCfg: any = {};
    Object.assign(
      layoutCfg,
      {
        width,
        height,
        center: [width / 2, height / 2],
      },
      this.layoutCfg,
    );
    this.layoutCfg = layoutCfg;

    const hasLayoutType = !!this.layoutType;

    let { layoutMethod } = this;
    if (layoutMethod) {
      layoutMethod.destroy();
    }

    graph.emit('beforelayout');
    const allHavePos = this.initPositions(layoutCfg.center, nodes);

    this.stopWorker();
    if (layoutCfg.workerEnabled && this.layoutWithWorker(this.data, success)) {
      // 如果启用布局web worker并且浏览器支持web worker，用web worker布局。否则回退到不用web worker布局。
      return true;
    }

    if (this.layoutType === 'force' || this.layoutType === 'g6force') {
      const { onTick } = layoutCfg;
      const tick = () => {
        if (onTick) {
          onTick();
        }
        graph.refreshPositions();
      };
      layoutCfg.tick = tick;
      const { onLayoutEnd } = layoutCfg;
      layoutCfg.onLayoutEnd = () => {
        if (onLayoutEnd) {
          onLayoutEnd();
        }
        graph.emit('afterlayout');
      };
    } else if (this.layoutType === 'comboForce') {
      layoutCfg.comboTrees = graph.get('comboTrees');
    }

    let enableTick = false;
    if (this.layoutType !== undefined) {
      try {
        layoutMethod = new Layout[this.layoutType](layoutCfg);
      } catch (e) {
        console.warn(
          `The layout method: ${this.layoutType} does not exist! Please specify it first.`,
        );
        return false;
      }

      // 是否需要迭代的方式完成布局。这里是来自布局对象的实例属性，是由布局的定义者在布局类定义的。
      enableTick = layoutMethod.enableTick;
      if (enableTick) {
        const { onTick, onLayoutEnd } = layoutCfg;
        const tick = () => {
          if (onTick) {
            onTick();
          }
          graph.refreshPositions();
        };
        layoutMethod.tick = tick;
        const onLayoutEndNew = () => {
          if (onLayoutEnd) {
            onLayoutEnd();
          }
          graph.emit('afterlayout');
        };
        layoutMethod.onLayoutEnd = onLayoutEndNew;
      }
      layoutMethod.init(this.data);
      // 若存在节点没有位置信息，且没有设置 layout，在 initPositions 中 random 给出了所有节点的位置，不需要再次执行 random 布局
      // 所有节点都有位置信息，且指定了 layout，则执行布局（代表不是第一次进行布局）
      if (hasLayoutType) {
        layoutMethod.execute();
      }
      this.layoutMethod = layoutMethod;
    }
    if ((hasLayoutType || !allHavePos) && (this.layoutType !== 'force' && !(enableTick))) {
      graph.emit('afterlayout');
      this.refreshLayout();
    }
    return false;
  }

  /**
   * layout with web worker
   * @param {object} data graph data
   * @param {function} success callback function
   * @return {boolean} 是否支持web worker
   */
  private layoutWithWorker(data, success?: () => void): boolean {
    const { nodes, edges } = data;
    const { layoutCfg, graph } = this;
    const worker = this.getWorker();
    // 每次worker message event handler调用之间的共享数据，会被修改。
    const { workerData } = this;

    if (!worker) {
      return false;
    }

    workerData.requestId = null;
    workerData.requestId2 = null;
    workerData.currentTick = null;
    workerData.currentTickData = null;

    graph.emit('beforelayout');
    // NOTE: postMessage的message参数里面不能包含函数，否则postMessage会报错，
    // 例如：'function could not be cloned'。
    // 详情参考：https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
    // 所以这里需要把过滤layoutCfg里的函数字段过滤掉。
    const filteredLayoutCfg = filterObject(layoutCfg, value => typeof value !== 'function');
    worker.postMessage({ type: LAYOUT_MESSAGE.RUN, nodes, edges, layoutCfg: filteredLayoutCfg });
    worker.onmessage = event => {
      this.handleWorkerMessage(event, data, success);
    };
    return true;
  }

  // success callback will be called when updating graph positions for the first time.
  private handleWorkerMessage(event, data, success?: () => void) {
    const { graph, workerData, layoutCfg } = this;
    const eventData = event.data;
    const { type } = eventData;
    const onTick = () => {
      if (layoutCfg.onTick) {
        layoutCfg.onTick();
      }
    };
    const onLayoutEnd = () => {
      if (layoutCfg.onLayoutEnd) {
        layoutCfg.onLayoutEnd();
      }
      graph.emit('afterlayout');
    };

    switch (type) {
      case LAYOUT_MESSAGE.TICK:
        workerData.currentTick = eventData.currentTick;
        workerData.currentTickData = eventData;
        if (!workerData.requestId) {
          workerData.requestId = helper.requestAnimationFrame(function () {
            updateLayoutPosition(data, eventData);
            graph.refreshPositions();
            onTick();
            if (eventData.currentTick === 1 && success) {
              success();
            }

            if (eventData.currentTick === eventData.totalTicks) {
              // 如果是最后一次tick
              onLayoutEnd();
            } else if (workerData.currentTick === eventData.totalTicks) {
              // 注意这里workerData.currentTick可能已经不再是前面赋值时候的值了，
              // 因为在requestAnimationFrame等待时间里，可能产生新的tick。
              // 如果当前tick不是最后一次tick，并且所有的tick消息都已发出来了，那么需要用最后一次tick的数据再刷新一次。
              workerData.requestId2 = helper.requestAnimationFrame(function () {
                updateLayoutPosition(data, workerData.currentTickData);
                graph.refreshPositions();
                workerData.requestId2 = null;
                onTick();
                onLayoutEnd();
              });
            }
            workerData.requestId = null;
          });
        }
        break;
      case LAYOUT_MESSAGE.END:
        // 如果没有tick消息（非力导布局）
        if (workerData.currentTick == null) {
          updateLayoutPosition(data, eventData);
          this.refreshLayout();
          // 非力导布局，没有tick消息，只有end消息，所以需要执行一次回调。
          if (success) {
            success();
          }
          graph.emit('afterlayout');
        }
        break;
      case LAYOUT_MESSAGE.ERROR:
        break;
      default:
        break;
    }
  }

  // 绘制
  public refreshLayout() {
    const { graph } = this;
    if (graph.get('animate')) {
      graph.positionsAnimate();
    } else {
      graph.refreshPositions();
    }
  }

  // 更新布局参数
  public updateLayoutCfg(cfg) {
    const { graph, layoutMethod } = this;

    this.layoutType = cfg.type;
    if (!layoutMethod) {
      console.warn(
        'You did not assign any layout type and the graph has no previous layout method!',
      );
      return;
    }
    this.data = this.setDataFromGraph();

    this.stopWorker();
    if (cfg.workerEnabled && this.layoutWithWorker(this.data, null)) {
      // 如果启用布局web worker并且浏览器支持web worker，用web worker布局。否则回退到不用web worker布局。
      return;
    }

    layoutMethod.init(this.data);
    layoutMethod.updateCfg(cfg);
    graph.emit('beforelayout');
    layoutMethod.execute();
    if (this.layoutType !== 'force' && !layoutMethod.enableTick) {
      graph.emit('afterlayout');
    }
    this.refreshLayout();
  }

  // 更换布局
  public changeLayout(layoutType: string) {
    const { graph, layoutMethod } = this;

    this.layoutType = layoutType;
    this.layoutCfg = graph.get('layout') || {};
    this.layoutCfg.type = layoutType;

    if (layoutMethod) {
      layoutMethod.destroy();
    }
    this.layout();
  }

  // 更换数据
  public changeData() {
    const { layoutMethod } = this;

    if (layoutMethod) {
      layoutMethod.destroy();
    }
    this.layout();
  }

  // 从 this.graph 获取数据
  public setDataFromGraph() {
    const nodes = [];
    const edges = [];
    const combos = [];
    const nodeItems = this.graph.getNodes();
    const edgeItems = this.graph.getEdges();
    const comboItems = this.graph.getCombos();
    nodeItems.forEach(nodeItem => {
      if (!nodeItem.isVisible()) return;
      const model = nodeItem.getModel();
      nodes.push(model);
    });
    edgeItems.forEach(edgeItem => {
      if (edgeItem.destroyed || !edgeItem.isVisible()) return;
      const model = edgeItem.getModel();
      if (!model.isComboEdge) edges.push(model);
    });
    comboItems.forEach(comboItem => {
      if (comboItem.destroyed || !comboItem.isVisible()) return;
      const model = comboItem.getModel();
      combos.push(model);
    });
    const data: any = { nodes, edges, combos };
    return data;
  }

  // 重新布局
  public relayout(reloadData?: boolean) {
    const { graph, layoutMethod, layoutCfg } = this;

    if (reloadData) {
      this.data = this.setDataFromGraph();
      const { nodes } = this.data;
      if (!nodes) {
        return false;
      }
      this.initPositions(layoutCfg.center, nodes)
      layoutMethod.init(this.data);
    }

    if (this.layoutType === 'force') {
      layoutMethod.ticking = false;
      layoutMethod.forceSimulation.stop();
    }
    graph.emit('beforelayout');
    layoutMethod.execute(reloadData);
    if (this.layoutType !== 'force' && !layoutMethod.enableTick) {
      graph.emit('afterlayout');
    }
    this.refreshLayout();
  }

  // 控制布局动画
  // eslint-disable-next-line class-methods-use-this
  public layoutAnimate() { }

  // // 根据 type 创建 Layout 实例
  // private _getLayout() {
  // }

  // 将当前节点的平均中心移动到原点
  public moveToZero() {
    const { graph } = this;

    const data = graph.get('data');
    const { nodes } = data;
    if (nodes[0].x === undefined || nodes[0].x === null || isNaN(nodes[0].x)) {
      return;
    }
    const meanCenter = [0, 0];
    nodes.forEach(node => {
      meanCenter[0] += node.x;
      meanCenter[1] += node.y;
    });
    meanCenter[0] /= nodes.length;
    meanCenter[1] /= nodes.length;
    nodes.forEach(node => {
      node.x -= meanCenter[0];
      node.y -= meanCenter[1];
    });
  }

  // 初始化节点到 center 附近
  public initPositions(center, nodes): boolean {
    const { graph } = this;
    if (!nodes) {
      return false;
    }
    let allHavePos = true;
    const width = graph.get('width') * 0.85;
    const height = graph.get('height') * 0.85;
    const nodeNum = nodes.length;
    const horiNum = Math.sqrt(width * nodeNum / height);
    const vertiNum = horiNum * height / width;
    const horiGap = width / (horiNum - 1);
    const vertiGap = height / (vertiNum - 1);
    const beginX = center[0] - width / 2;
    const beginY = center[1] - height / 2;
    nodes.forEach((node, i) => {
      if (isNaN(node.x)) {
        allHavePos = false;
        node.x = i % horiNum * horiGap + beginX;
      }
      if (isNaN(node.y)) {
        allHavePos = false;
        node.y = i / horiNum * vertiGap + beginY;
      }
    });
    return allHavePos;
  }

  public destroy() {
    const { layoutMethod } = this;

    this.graph = null;

    if (layoutMethod) {
      layoutMethod.destroy();
    }
    const { worker } = this;
    if (worker) {
      worker.terminate();
      this.worker = null;
    }
    this.destroyed = true;
  }
}

function updateLayoutPosition(data, layoutData) {
  const { nodes } = data;
  const { nodes: layoutNodes } = layoutData;
  nodes.forEach((node, i) => {
    node.x = layoutNodes[i].x;
    node.y = layoutNodes[i].y;
  });
}

function filterObject(collection, callback) {
  const result = {};
  if (collection && typeof collection === 'object') {
    Object.keys(collection).forEach(key => {
      if (collection.hasOwnProperty(key) && callback(collection[key])) {
        result[key] = collection[key];
      }
    });

    return result;
  }
  return collection;
}
