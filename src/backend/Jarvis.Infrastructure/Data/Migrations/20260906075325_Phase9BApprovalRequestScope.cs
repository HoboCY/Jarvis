using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase9BApprovalRequestScope : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Approvals_DeviceId_RequestId",
                table: "Approvals");

            migrationBuilder.CreateIndex(
                name: "IX_Approvals_DeviceId_ExecutionId_RequestId",
                table: "Approvals",
                columns: new[] { "DeviceId", "ExecutionId", "RequestId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Approvals_DeviceId_ExecutionId_RequestId",
                table: "Approvals");

            migrationBuilder.CreateIndex(
                name: "IX_Approvals_DeviceId_RequestId",
                table: "Approvals",
                columns: new[] { "DeviceId", "RequestId" },
                unique: true);
        }
    }
}
