import { DevToolsNode } from 'protocol';
import { CollectionViewer, DataSource } from '@angular/cdk/collections';
import { BehaviorSubject, merge, Observable } from 'rxjs';
import { MatTreeFlattener } from '@angular/material/tree';
import { FlatTreeControl } from '@angular/cdk/tree';
import { map } from 'rxjs/operators';
import { DefaultIterableDiffer } from '@angular/core';
import { IndexedNode, indexForest } from './index-forest';
import { diff } from '../../diffing';

/** Flat node with expandable and level information */
export interface FlatNode {
  id: string;
  expandable: boolean;
  name: string;
  directives: string;
  position: number[];
  level: number;
  original: IndexedNode;
  newItem?: boolean;
}

const expandable = (node: IndexedNode) => !!node.children && node.children.length > 0;

const trackBy = (_: number, item: FlatNode) => `${item.id}#${item.expandable}`;

const getId = (node: IndexedNode) => {
  let prefix = '';
  if (node.component) {
    prefix = node.component.id.toString();
  }
  const dirIds = node.directives
    .map((d) => d.id)
    .sort((a, b) => {
      return a - b;
    });
  return prefix + '-' + dirIds.join('-');
};

/**
 * Takes an `IndexedNode` forest and returns a transformed forest without `#comment` nodes.
 * The algorithm has linear complexity and O(depth(forest)) memory complexity.
 *
 * @param nodes indexed nodes, which have already have associated positions within the original
 *  tree and associated indices.
 * @returns forest with filtered `#comment` nodes.
 */
const filterCommentNodes = (nodes: IndexedNode[]) => {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.element !== '#comment') {
      continue;
    }
    nodes.splice(i, 1, ...node.children);
    i--;
  }
  for (const node of nodes) {
    filterCommentNodes(node.children);
  }
  return nodes;
};

export class ComponentDataSource extends DataSource<FlatNode> {
  private _differ = new DefaultIterableDiffer(trackBy);
  private _expandedData = new BehaviorSubject<FlatNode[]>([]);
  private _flattenedData = new BehaviorSubject<FlatNode[]>([]);
  private _nodeToFlat = new WeakMap<IndexedNode, FlatNode>();

  private _treeFlattener = new MatTreeFlattener(
    (node: IndexedNode, level: number) => {
      if (this._nodeToFlat.has(node)) {
        return this._nodeToFlat.get(node);
      }
      const flatNode: FlatNode = {
        expandable: expandable(node),
        id: getId(node),
        // We can compare the nodes in the navigation functions above
        // based on this identifier directly, since it's a reference type
        // and the reference is preserved after transformation.
        position: node.position,
        name: node.component ? node.component.name : node.element,
        directives: node.directives.map((d) => d.name).join(', '),
        original: node,
        level,
      };
      this._nodeToFlat.set(node, flatNode);
      return flatNode;
    },
    (node) => (node ? node.level : -1),
    (node) => (node ? node.expandable : false),
    (node) => (node ? node.children : [])
  );

  constructor(private _treeControl: FlatTreeControl<FlatNode>) {
    super();
  }

  get data(): FlatNode[] {
    return this._flattenedData.value;
  }

  get expandedDataValues(): FlatNode[] {
    return this._expandedData.value;
  }

  getFlatNodeFromIndexedNode(indexedNode: IndexedNode): FlatNode | undefined {
    return this._nodeToFlat.get(indexedNode);
  }

  update(
    forest: DevToolsNode[],
    showCommentNodes: boolean
  ): { newItems: FlatNode[]; movedItems: FlatNode[]; removedItems: FlatNode[] } {
    if (!forest) {
      return { newItems: [], movedItems: [], removedItems: [] };
    }

    let indexedForest = indexForest(forest);

    // We filter comment nodes here because we need to preserve the positions within the component tree.
    //
    // For example:
    // ```
    // - #comment
    //   - bar
    // ```
    //
    // #comment's position will be [0] and bar's will be [0, 0]. If we trim #comment nodes earlier
    // before indexing, bar's position will be [0] which will be inaccurate and will make the backend
    // enable to find the corresponding node when we request its properties.
    if (!showCommentNodes) {
      indexedForest = filterCommentNodes(indexedForest);
    }

    const flattenedCollection = this._treeFlattener.flattenNodes(indexedForest) as FlatNode[];

    this.data.forEach((i) => (i.newItem = false));

    const expandedNodes = {};
    this.data.forEach((item) => {
      expandedNodes[item.id] = this._treeControl.isExpanded(item);
    });

    const { newItems, movedItems, removedItems } = diff<FlatNode>(this._differ, this.data, flattenedCollection);
    this._treeControl.dataNodes = this.data;
    this._flattenedData.next(this.data);

    movedItems.forEach((i) => {
      this._nodeToFlat.set(i.original, i);
      if (expandedNodes[i.id]) {
        this._treeControl.expand(i);
      }
    });
    newItems.forEach((i) => (i.newItem = true));
    removedItems.forEach((i) => this._nodeToFlat.delete(i.original));

    return { newItems, movedItems, removedItems };
  }

  connect(collectionViewer: CollectionViewer): Observable<FlatNode[]> {
    const changes = [collectionViewer.viewChange, this._treeControl.expansionModel.changed, this._flattenedData];
    return merge(...changes).pipe(
      map(() => {
        this._expandedData.next(this._treeFlattener.expandFlattenedNodes(this.data, this._treeControl) as FlatNode[]);
        return this._expandedData.value;
      })
    );
  }

  disconnect(): void {}
}
