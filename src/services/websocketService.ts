import { Server } from 'socket.io';
import { Server as HTTPServer } from 'http';

export class WebSocketService {
  private io: Server | null = null;

  init(server: HTTPServer) {
    this.io = new Server(server, {
      cors: {
        origin: '*', // In production, restrict this
        methods: ['GET', 'POST'],
      },
    });

    this.io.on('connection', (socket) => {
      console.log('User connected to WebSocket:', socket.id);

      socket.on('subscribe', (userId: string) => {
        socket.join(`user:${userId}`);
        console.log(`Socket ${socket.id} subscribed to user:${userId}`);
      });

      socket.on('disconnect', () => {
        console.log('User disconnected from WebSocket:', socket.id);
      });
    });
  }

  notifyUser(userId: string, event: string, data: any) {
    if (this.io) {
      console.log(`Sending ${event} to user:${userId}`);
      this.io.to(`user:${userId}`).emit(event, data);
    }
  }
}

export const webSocketService = new WebSocketService();
