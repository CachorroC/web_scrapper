export interface CommentNode {
  author  : string;
  comment : string;
  time    : string | Date;
  likes   : number;
  // The recursive part: an array of this exact same interface
  replies?: CommentNode[];
}